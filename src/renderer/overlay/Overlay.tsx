import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { FLAGS } from '@shared/flags';
import type { ClientInfo } from '@shared/ipc';
import type {
  AnswerFormat,
  CompanionStatusEvent,
  ContributionDeltaEvent,
  ContributionDoneEvent,
  ContributionOpenEvent,
  ContributionPatchEvent,
  ContributionResetEvent,
  InterviewType,
} from '@shared/types';
import { HeadphonesIcon } from '../components/icons';
import { splitPronunciation } from './pronunciation';
import type { CardModel } from './cards/model';
import { ContributionCard } from './cards/ContributionCard';
import { useOverlayStore } from './store/useOverlayStore';
import { createStreamBuffer } from './lib/streamBuffer';
import { noDrag } from './lib/style';
import { AnswerControls } from './controls/AnswerControls';
import { AskBar } from './controls/AskBar';
import { CompanionBar } from './controls/CompanionBar';
import { VoiceBar } from './controls/VoiceBar';
import { useVoice } from './voice/useVoice';
import { EqualizerBars } from './controls/EqualizerBars';
import { HeaderBar } from './controls/HeaderBar';
import { SessionBar } from './controls/SessionBar';
import { AudioMeter } from './panels/AudioMeter';
import { CapturesPanel } from './panels/CapturesPanel';
import { ClientNotesPanel } from './panels/ClientNotesPanel';
import { DataSentPanel } from './panels/DataSentPanel';
import { ErrorBanner } from './panels/ErrorBanner';
import { SettingsModal } from './panels/SettingsModal';
import { TranscriptPanel, MAX_LINES, type Line } from './panels/TranscriptPanel';

// Mic-level thresholds for "someone is speaking" — with hysteresis (turn on at a
// higher level than it turns off) so the meter doesn't flicker on/off at the
// boundary or twitch on background noise.
const SPEAK_ON = 0.05;
const SPEAK_OFF = 0.035;

/**
 * The Cue Card shell: window-level state (appearance, privacy, click-through),
 * IPC subscriptions, and composition. The contribution feed lives in
 * store/useOverlayStore (dispatched to from the generic contribution events);
 * each card kind renders through cards/registry. Controls and panels are
 * presentational — every cross-process action funnels back through here or
 * calls the preload api directly.
 */
export default function Overlay() {
  // Contribution cards: the newest is the live/streaming one. With history on,
  // prior cards are kept collapsed instead of replaced; each is removable.
  const cards = useOverlayStore((s) => s.cards);
  const historyEnabled = useOverlayStore((s) => s.historyEnabled);

  const [fontSize, setFontSize] = useState(14);
  const [opacity, setOpacity] = useState(0.95);
  const [mode, setMode] = useState<'compact' | 'expanded'>('compact');
  const [clickthrough, setClickthrough] = useState(false);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(false);
  const [showData, setShowData] = useState(false); // "Data sent" panel expanded
  const [openCite, setOpenCite] = useState<string | null>(null); // expanded citation: `${cardId}:${n}`
  const [copiedId, setCopiedId] = useState<number | null>(null); // card id showing a brief "copied ✓"
  const [privacy, setPrivacy] = useState(true);
  const [privacyUnsupported, setPrivacyUnsupported] = useState(false); // Linux: no-op
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [showClient, setShowClient] = useState(false);
  // Live answer controls (mirrored to the active session via setAnswerPrefs).
  const [interviewType, setInterviewType] = useState<InterviewType>('general');
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('key_points');
  const [pronunciation, setPronunciation] = useState(true);
  // Coding sessions default to listen-only (don't auto-answer the interviewer, so a
  // generated coding answer isn't replaced). This toggle (coding-only) flips it on.
  const [answerInterviewer, setAnswerInterviewer] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Voice/summon runtime (Prompt 9): dialogue state mirror, push-to-talk
  // capture + VAD, and speech playback. Inert while the flag is off.
  const { voice, prefs: voicePrefs, level: voiceLevel, toggleMute, savePrefs } = useVoice(FLAGS.voice);

  // Companion session status (presence dial + live cost) — null outside
  // companion sessions. Memory cards can be corrected in place (small editor).
  const [companionStatus, setCompanionStatus] = useState<CompanionStatusEvent | null>(null);
  const [memoryEdit, setMemoryEdit] = useState<{ id: string; cardId: number; content: string } | null>(null);

  // Backend session failure (transcription socket dropped, OpenAI auth, etc.).
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false); // STT socket auto-recovery in progress

  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false); // hysteresis over `level`
  // Accumulated problem screenshots (multi-image capture) — owned by main, mirrored here.
  const [captures, setCaptures] = useState<string[]>([]);

  // Live transcript (the conversation feed), so the dashboard can be minimized.
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [interim, setInterim] = useState('');
  const [interimSpeaker, setInterimSpeaker] = useState('interviewer'); // 'them' in meetings
  const lineId = useRef(0);
  const prevLive = useRef(false);

  const cleanup = useRef<(() => void)[]>([]);
  // rAF-coalesced token buffer, one lane per contribution id (see lib/streamBuffer).
  const buffer = useRef(
    createStreamBuffer((chunks) => useOverlayStore.getState().append(chunks)),
  );

  useEffect(() => {
    const feed = () => useOverlayStore.getState();
    const buf = buffer.current;

    cleanup.current.push(
      api.events.onContributionOpen((p: ContributionOpenEvent) => {
        feed().open(p);
        // Mirror the dashboard: surface the detected question in the transcript too.
        setTranscript((t) =>
          [...t, { id: lineId.current++, speaker: 'detected question', text: p.title }].slice(
            -MAX_LINES * 2,
          ),
        );
      }),
      api.events.onContributionDelta((p: ContributionDeltaEvent) =>
        buf.push(p.contributionId, p.token),
      ),
      api.events.onContributionPatch((p: ContributionPatchEvent) => feed().patch(p)),
      api.events.onContributionDone((p: ContributionDoneEvent) => {
        buf.flush();
        feed().done(p.contributionId);
      }),
      // Regenerate: clear THAT card's body (transcript untouched) so the re-streamed
      // tokens don't append to the old one. Reuses the same card (routed by id);
      // only this stream's buffered tokens are dropped — concurrent streams keep theirs.
      api.events.onContributionReset((p: ContributionResetEvent) => {
        buf.drop(p.contributionId);
        feed().reset(p.contributionId);
      }),
      api.events.onTranscriptDelta((p) => {
        const d = p as { text: string; speaker: string; isFinal: boolean };
        if (d.speaker) setInterimSpeaker(d.speaker);
        if (d.isFinal) {
          setTranscript((t) =>
            [...t, { id: lineId.current++, speaker: d.speaker, text: d.text }].slice(-MAX_LINES * 2),
          );
          setInterim('');
        } else {
          setInterim((s) => s + d.text);
        }
      }),
      api.events.onCaptureBuffer((p) => setCaptures(p.images)),
      api.events.onSessionError((p) =>
        setSessionError((p as { message?: string }).message || 'Session error.'),
      ),
      api.events.onTranscriberStatus((p) => setReconnecting(p.status === 'reconnecting')),
      api.events.onSessionState((p) => {
        const s = p as { paused: boolean; status: string };
        const nowLive = s.status === 'live';
        setPaused(s.paused);
        setLive(nowLive);
        if (s.paused) {
          setLevel(0); // flatten the meter while paused
          setSpeaking(false);
        }
        // A fresh round just went live — clear the previous session's Cue Card.
        if (nowLive && !prevLive.current) {
          buf.cancel();
          lineId.current = 0;
          setTranscript([]);
          setInterim('');
          feed().clear();
          setSessionError(null);
          setReconnecting(false);
        }
        // Session stopped: drop the dangling interim partial + streaming cursor so
        // the Cue Card doesn't look like it's still listening.
        if (!nowLive) {
          setInterim('');
          feed().stopStreaming();
          setLevel(0);
          setSpeaking(false);
          setReconnecting(false);
          setCompanionStatus(null);
          setMemoryEdit(null);
        }
        prevLive.current = nowLive;
      }),
      api.events.onOverlayApplySettings((p) => {
        const s = p as { opacity: number; fontSize: number; mode: 'compact' | 'expanded' };
        setOpacity(s.opacity);
        setFontSize(s.fontSize);
        setMode(s.mode);
      }),
      api.events.onPrivacyChanged((p) => setPrivacy((p as { enabled: boolean }).enabled)),
      api.events.onClientInfo((p) => {
        setClientInfo(p);
        if (!p) setShowClient(false);
      }),
      api.events.onAnswerPrefs((p) => {
        setInterviewType(p.interviewType);
        setAnswerFormat(p.format);
        setPronunciation(p.pronunciation);
      }),
      api.events.onAudioLevel((p) => {
        setLevel(p.level);
        setSpeaking((was) => (was ? p.level > SPEAK_OFF : p.level > SPEAK_ON));
      }),
      api.events.onCompanionStatus((p) => setCompanionStatus(p)),
    );
    void api.privacy.get().then((p) => {
      setPrivacy(p.enabled);
      setPrivacyUnsupported(!p.supported);
    });
    return () => {
      buf.cancel();
      cleanup.current.forEach((u) => u());
    };
  }, []);

  // Derived from the cards list. The "focus" card = whichever is currently streaming
  // (so regenerating an OLDER card still drives the header + transparency panels),
  // else the newest.
  const streaming = cards.some((c) => c.streaming);
  const current = cards.find((c) => c.streaming) ?? cards[cards.length - 1];
  const question = current?.title ?? '';
  const meta = current?.meta ?? null;
  const context = current?.context ?? null;

  // Coding: keep the interviewer audio transcribing but suppress auto-answers by
  // default; non-coding sessions always auto-answer. Toggling it on (in coding) also
  // answers what the interviewer just asked (handled in main).
  useEffect(() => {
    if (!live) return;
    void api.session.setAnswering(interviewType !== 'coding' || answerInterviewer);
  }, [live, interviewType, answerInterviewer]);

  const togglePrivacy = async () => {
    const { enabled } = (await api.privacy.toggle()) as { enabled: boolean };
    setPrivacy(enabled);
  };

  const applyOpacity = (v: number) => {
    setOpacity(v);
    void api.overlay.setOpacity(v);
  };
  const applyMode = (m: 'compact' | 'expanded') => {
    setMode(m);
    void api.overlay.setMode(m);
  };

  // --- live answer controls ---
  // Changing type/format/pronunciation updates the active session and
  // re-generates the current question so the new form appears immediately.
  const changeInterviewType = async (t: InterviewType) => {
    setInterviewType(t);
    await api.session.setAnswerPrefs({ interviewType: t });
    if (question) await api.session.regenerate();
  };
  const changeFormat = async (f: AnswerFormat) => {
    setAnswerFormat(f);
    await api.session.setAnswerPrefs({ format: f });
    if (question) await api.session.regenerate();
  };
  const togglePronunciation = async () => {
    const next = !pronunciation;
    setPronunciation(next);
    await api.session.setAnswerPrefs({ pronunciation: next });
    if (question) await api.session.regenerate();
  };
  // Regenerate ONE card (its per-card ↻ button). Live-session questions re-run
  // via the answer pipeline; a coding-solve card isn't a persisted question, so
  // that returns {regenerated:false} and we re-solve the last coding problem instead.
  const regenerateCard = async (card: CardModel) => {
    const r = await api.session.regenerate(card.contributionId);
    if (!r.regenerated) await api.capture.resolveLast();
  };
  // Copy ONE card's body (clean — no pronunciation guide) to the clipboard.
  // Handy for coding solves: copy the solution, paste into the editor.
  const copyCard = (card: CardModel) => {
    const text = splitPronunciation(card.body).body.trim();
    if (!text) return;
    void api.overlay
      .copyText(text)
      .then(() => {
        setCopiedId(card.id);
        window.setTimeout(() => setCopiedId((v) => (v === card.id ? null : v)), 1200);
      })
      .catch(() => {});
  };
  const clearAnswer = () => {
    buffer.current.cancel(); // full clear — every stream's buffer goes
    useOverlayStore.getState().clear(); // clear all cards (each also has its own ×)
    void api.session.clearAnswer();
  };

  // --- memory card actions (companion) ---
  // A surfaced memory can be corrected or forgotten RIGHT ON the card — trust
  // requires the fix to live where the mistake showed up.
  const cardMemoryId = (card: CardModel): string | null => {
    const id = (card.meta as Record<string, unknown> | null)?.memoryId;
    return typeof id === 'string' ? id : null;
  };
  const correctMemory = (card: CardModel) => {
    const id = cardMemoryId(card);
    if (id) setMemoryEdit({ id, cardId: card.id, content: card.body });
  };
  const saveMemoryEdit = async () => {
    if (!memoryEdit) return;
    const text = memoryEdit.content.trim();
    if (!text) return;
    try {
      await api.memory.update(memoryEdit.id, { content: text });
      useOverlayStore.getState().replaceBody(memoryEdit.cardId, text);
      setMemoryEdit(null);
    } catch (e) {
      setSessionError((e as Error).message); // e.g. the sensitive-content guard
    }
  };
  const forgetMemory = async (card: CardModel) => {
    const id = cardMemoryId(card);
    if (!id) return;
    try {
      await api.memory.delete(id);
      useOverlayStore.getState().remove(card.id);
    } catch (e) {
      setSessionError((e as Error).message);
    }
  };

  // The global shortcut (Ctrl+Shift+\) toggles click-through via the main process.
  useEffect(() => api.events.onOverlayClickthrough(() => setClickthrough((c) => !c)), []);

  // Per-region click-through. Electron ignores the mouse per-WINDOW, so making the
  // whole Cue Card click-through would trap its own buttons. Instead, while it's on
  // we flip ignore as the cursor enters/leaves the control bar — mouse-move is still
  // forwarded while ignoring ({forward:true}) — so the header stays clickable and
  // only the answer area passes clicks through to the app behind.
  useEffect(() => {
    if (!clickthrough) {
      void api.overlay.setClickthrough(false);
      return;
    }
    let ignoring = false;
    const onMove = (e: MouseEvent) => {
      const overUI = !!(
        document.elementFromPoint(e.clientX, e.clientY) as Element | null
      )?.closest('[data-ct-interactive]');
      if (!overUI !== ignoring) {
        ignoring = !overUI;
        void api.overlay.setClickthrough(ignoring);
      }
    };
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
      void api.overlay.setClickthrough(false);
    };
  }, [clickthrough]);

  return (
    <div
      className="flex h-screen flex-col bg-neutral-900 p-2.5 text-neutral-100"
      style={{ fontSize: `${fontSize}px` }}
    >
      <HeaderBar
        paused={paused}
        streaming={streaming}
        live={live}
        speaking={speaking}
        reconnecting={reconnecting}
        privacy={privacy}
        privacyUnsupported={privacyUnsupported}
        clickthrough={clickthrough}
        mode={mode}
        clientInfo={clientInfo}
        showClient={showClient}
        onTogglePrivacy={() => void togglePrivacy()}
        onToggleClickthrough={() => setClickthrough((c) => !c)}
        onToggleMode={() => applyMode(mode === 'compact' ? 'expanded' : 'compact')}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleClient={() => setShowClient((s) => !s)}
      />

      {showClient && clientInfo && <ClientNotesPanel clientInfo={clientInfo} />}

      {captures.length > 0 && <CapturesPanel captures={captures} />}

      {sessionError && (
        <ErrorBanner message={sessionError} onDismiss={() => setSessionError(null)} />
      )}

      {live && <SessionBar clientInfo={clientInfo} paused={paused} />}

      {/* Companion sessions: live presence dial + visible cost estimate. */}
      {live && companionStatus && <CompanionBar status={companionStatus} />}

      {live && companionStatus && <CompanionBar status={companionStatus} />}

      {live && (
        <AnswerControls
          interviewType={interviewType}
          answerFormat={answerFormat}
          pronunciation={pronunciation}
          answerInterviewer={answerInterviewer}
          historyEnabled={historyEnabled}
          onChangeType={(t) => void changeInterviewType(t)}
          onChangeFormat={(f) => void changeFormat(f)}
          onTogglePronunciation={() => void togglePronunciation()}
          onToggleAnswerInterviewer={() => setAnswerInterviewer((v) => !v)}
          onToggleHistory={() => useOverlayStore.getState().setHistoryEnabled(!historyEnabled)}
          onClear={clearAnswer}
        />
      )}

      {live && mode === 'expanded' && <AudioMeter level={level} speaking={speaking} />}

      {(live || transcript.length > 0 || interim) && (
        <TranscriptPanel lines={transcript} interim={interim} interimSpeaker={interimSpeaker} />
      )}

      {/* Contribution cards — the newest streams; older ones are kept (collapsed)
          when history is on. Click a collapsed card to expand; × removes one. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-auto" style={noDrag}>
        {cards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-neutral-500">
            {live && !paused ? (
              <>
                <EqualizerBars />
                <span className="mt-2 text-xs">Listening… answers will appear here.</span>
              </>
            ) : (
              <>
                <HeadphonesIcon className="h-7 w-7 text-neutral-600" />
                <span className="mt-2 text-xs">
                  Ready. Start an interview from the dashboard —
                  <br />
                  the transcript &amp; suggested answers stream here.
                </span>
              </>
            )}
          </div>
        ) : (
          cards.map((c, i) => (
            <ContributionCard
              key={c.id}
              card={c}
              isCurrent={i === cards.length - 1}
              live={live}
              paused={paused}
              copied={copiedId === c.id}
              openCite={openCite}
              onToggleCite={setOpenCite}
              onToggleCollapsed={() => useOverlayStore.getState().toggle(c.id)}
              onCopy={() => copyCard(c)}
              onRegenerate={() => void regenerateCard(c)}
              onRemove={() => useOverlayStore.getState().remove(c.id)}
              onCorrectMemory={() => correctMemory(c)}
              onForgetMemory={() => void forgetMemory(c)}
            />
          ))
        )}
      </div>

      {/* Inline memory editor — correcting a surfaced memory updates the saved
          item itself (and re-embeds it), not just this card. */}
      {memoryEdit && (
        <div
          data-ct-interactive
          className="mt-2 shrink-0 rounded-lg border border-violet-500/40 bg-neutral-950 p-2"
          style={noDrag}
        >
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">
            Correct this memory
          </p>
          <textarea
            value={memoryEdit.content}
            onChange={(e) => setMemoryEdit((m) => (m ? { ...m, content: e.target.value } : m))}
            rows={3}
            className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-violet-500"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              onClick={() => setMemoryEdit(null)}
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              Cancel
            </button>
            <button
              onClick={() => void saveMemoryEdit()}
              className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500"
            >
              Save memory
            </button>
          </div>
        </div>
      )}

      {live && <AskBar />}

      {/* In-place memory correction (a memory card's ✎). Saves through the
          same review-guarded update path as Library › Memory. */}
      {memoryEdit && (
        <div data-ct-interactive className="mt-2 shrink-0 rounded-md border border-violet-500/40 bg-neutral-950 p-2" style={noDrag}>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">
            Correct memory
          </p>
          <textarea
            value={memoryEdit.content}
            onChange={(e) => setMemoryEdit({ ...memoryEdit, content: e.target.value })}
            rows={3}
            className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-violet-500"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              onClick={() => setMemoryEdit(null)}
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              Cancel
            </button>
            <button
              onClick={() => void saveMemoryEdit()}
              className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Voice is session-independent: with nothing live a summon quick-asks
          over the default Space, so the bar renders whenever the flag is on. */}
      {FLAGS.voice && (
        <VoiceBar voice={voice} prefs={voicePrefs} level={voiceLevel} onToggleMute={() => void toggleMute()} />
      )}

      {meta?.riskWarning && (
        <p
          className="mt-2 shrink-0 rounded bg-amber-900/40 px-2 py-1 text-[11px] text-amber-300"
          style={noDrag}
        >
          ⚠ {meta.riskWarning}
        </p>
      )}

      {context && (
        <DataSentPanel context={context} show={showData} onToggle={() => setShowData((s) => !s)} />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        opacity={opacity}
        onOpacity={applyOpacity}
        fontSize={fontSize}
        onFontSize={setFontSize}
        voicePrefs={FLAGS.voice ? voicePrefs : null}
        onSaveVoicePrefs={(patch) => void savePrefs(patch)}
      />
    </div>
  );
}
