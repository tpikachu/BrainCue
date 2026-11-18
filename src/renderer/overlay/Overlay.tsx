import { useEffect, useRef, useState } from 'react';
import { createSettingsFeed } from '../lib/settingsFeed';
import { api } from '../lib/api';
import { hasUsefulText } from '../lib/usefulText';
import { FLAGS } from '@shared/flags';
import type { ClientInfo } from '@shared/ipc';
import type {
  AnswerFormat,
  AppSettings,
  CompanionStatusEvent,
  ContributionDeltaEvent,
  ContributionDoneEvent,
  ContributionOpenEvent,
  ContributionPatchEvent,
  ContributionResetEvent,
  CaptureStatus,
  InterviewType,
} from '@shared/types';
import { cloudProvider } from '@shared/providers';
import { HeadphonesIcon } from '../components/icons';
import { rollbackMessage } from '../lib/rollbackCopy';
import type { PickerTask } from '../lib/modelChoice';
import { splitPronunciation } from './pronunciation';
import type { CardModel } from './cards/model';
import { ContributionCard } from './cards/ContributionCard';
import { useOverlayStore } from './store/useOverlayStore';
import { createStreamBuffer } from './lib/streamBuffer';
import { noDrag } from './lib/style';
import { AskBar } from './controls/AskBar';
import { CompanionBar } from './controls/CompanionBar';
import { VoiceBar } from './controls/VoiceBar';
import { useVoice } from './voice/useVoice';
import { EqualizerBars } from './controls/EqualizerBars';
import { HeaderBar } from './controls/HeaderBar';
import { MoreTray } from './controls/MoreTray';
import { cueLayout, missLabel } from './cueLayout';
import { AudioMeter } from './panels/AudioMeter';
import { CapturesPanel } from './panels/CapturesPanel';
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
  /** The ⋯ tray: everything a live call does not need at a glance. */
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  /** Earlier cards, behind one toggle (missed questions stay visible). */
  const [showEarlier, setShowEarlier] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Live answer controls (mirrored to the active session via setAnswerPrefs).
  const [interviewType, setInterviewType] = useState<InterviewType>('general');
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('general');
  const [pronunciation, setPronunciation] = useState(true);
  // Coding sessions default to listen-only (don't auto-answer the interviewer, so a
  // generated coding answer isn't replaced). This toggle (coding-only) flips it on.
  const [answerInterviewer, setAnswerInterviewer] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persisted settings, for the model chips (which model each task's NEXT
  // request uses, which providers have keys). Main pushes them on every
  // change from any window and whenever a task's route moves (a model found
  // unavailable, new discovery) — EVENTS.settingsChanged.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Reads and write replies can land after a newer push: the feed drops any
  // reply older than what is shown, so a held read can no longer put the
  // previous model back on a chip (settingsFeed.ts).
  const [settingsFeed] = useState(() => createSettingsFeed<AppSettings>(setSettings));
  /** Main's route for the answer task — only for a card whose context event
   *  predates `sentTo`; a card names where ITS sources went. */
  const [answerProvider, setAnswerProvider] = useState<string | null>(null);
  const routeRead = useRef(0); // only the latest readiness read applies
  const loadRoute = () => {
    const at = ++routeRead.current;
    void api.settings
      .readiness()
      .then((r) => {
        if (at === routeRead.current) setAnswerProvider(cloudProvider(r.routes.answer)?.name ?? r.routes.answer);
      })
      .catch(() => {});
  };
  const loadSettings = () => {
    loadRoute();
    return settingsFeed.request(api.settings.get() as Promise<AppSettings>).catch(() => {});
  };

  // Voice/summon runtime: dialogue state mirror, push-to-talk
  // capture + VAD, and speech playback. Inert while the flag is off.
  const { voice, prefs: voicePrefs, level: voiceLevel, toggleMute, savePrefs } = useVoice(FLAGS.voice);

  // Companion session status (presence dial + live cost) — null outside
  // companion sessions. Memory cards can be corrected in place (small editor).
  const [companionStatus, setCompanionStatus] = useState<CompanionStatusEvent | null>(null);
  const [memoryEdit, setMemoryEdit] = useState<{ id: string; cardId: number; content: string } | null>(null);

  // Backend session failure (transcription socket dropped, OpenAI auth, etc.).
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false); // STT socket auto-recovery in progress
  // Which audio streams are actually flowing (reported by the dashboard).
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const captureNotice = !capture
    ? null
    : capture.wantsSystem && !capture.system && !capture.mic
      ? 'No audio is being captured — nothing can be heard. Stop and start again.'
      : capture.wantsSystem && !capture.system
        ? 'Call audio is not captured — the interviewer’s questions can’t be heard. Use “Answer that” or type them.'
        : !capture.mic
          ? capture.wantsSystem
            ? 'Your microphone is not captured — answers won’t know what you actually said.'
            : 'Your microphone is not captured — nothing can be heard.'
          : null;

  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false); // hysteresis over `level`
  // Accumulated problem screenshots (multi-image capture) — owned by main, mirrored here.
  const [captures, setCaptures] = useState<string[]>([]);

  // Live transcript (the conversation feed), so the dashboard can be minimized.
  const [transcript, setTranscript] = useState<Line[]>([]);
  // One in-flight line per speaker: the call's partial and the user's own
  // partial arrive interleaved and must never be appended into one string.
  const [interims, setInterims] = useState<Record<string, string>>({});
  const lineId = useRef(0);
  const prevLive = useRef(false);

  const cleanup = useRef<(() => void)[]>([]);
  // Contributions whose first USEFUL painted words were already reported to
  // main (the latency record's acceptance measure — measured after paint, so
  // it is what the user saw, not when a token arrived; and only once the text
  // holds a real word, never a bare "**" or "- "). Cleared on reset/regenerate.
  const reportedVisible = useRef(new Set<string>());
  // Text streamed so far for cards not yet reported (usually a few chars).
  const unreported = useRef(new Map<string, string>());
  // rAF-coalesced token buffer, one lane per contribution id (see lib/streamBuffer).
  const buffer = useRef(
    createStreamBuffer((chunks) => {
      useOverlayStore.getState().append(chunks);
      for (const [id, chunk] of chunks) {
        if (reportedVisible.current.has(id)) continue;
        const sofar = (unreported.current.get(id) ?? '') + chunk;
        if (!hasUsefulText(sofar)) {
          unreported.current.set(id, sofar);
          continue;
        }
        unreported.current.delete(id);
        reportedVisible.current.add(id);
        // Two frames: the first runs before React commits this append, the
        // second after the browser has painted it.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => void api.metrics.firstUseful(id, Date.now()).catch(() => {})),
        );
      }
    }),
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
        reportedVisible.current.delete(p.contributionId);
        unreported.current.delete(p.contributionId);
        buf.drop(p.contributionId);
        feed().reset(p.contributionId);
      }),
      api.events.onTranscriptDelta((p) => {
        const d = p as { text: string; speaker: string; isFinal: boolean; clear?: boolean };
        const drop = (m: Record<string, string>) => {
          const { [d.speaker]: _gone, ...rest } = m;
          return rest;
        };
        if (d.clear) {
          setInterims(drop); // an own turn judged an echo of the call — no final follows
        } else if (d.isFinal) {
          setTranscript((t) =>
            [...t, { id: lineId.current++, speaker: d.speaker, text: d.text }].slice(-MAX_LINES * 2),
          );
          setInterims(drop);
        } else {
          setInterims((m) => ({ ...m, [d.speaker]: (m[d.speaker] ?? '') + d.text }));
        }
      }),
      api.events.onCaptureBuffer((p) => setCaptures(p.images)),
      api.events.onSessionError((p) =>
        setSessionError((p as { message?: string }).message || 'Session error.'),
      ),
      api.events.onTranscriberStatus((p) => setReconnecting(p.status === 'reconnecting')),
      api.events.onCaptureStatus((p) => setCapture(p)),
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
          setInterims({});
          feed().clear();
          setSessionError(null);
          setReconnecting(false);
          setShowEarlier(false);
          setMoreOpen(false);
        }
        // Session stopped: drop the dangling interim partial + streaming cursor so
        // the Cue Card doesn't look like it's still listening.
        if (!nowLive) {
          setInterims({});
          feed().stopStreaming();
          setLevel(0);
          setSpeaking(false);
          setReconnecting(false);
          setCompanionStatus(null);
          setMemoryEdit(null);
          setCapture(null);
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
      api.events.onClientInfo((p) => setClientInfo(p)),
      // A failed start's rollback, settled from either window: if it could
      // not be confirmed, this window says so too.
      api.events.onSessionRollback((r) => {
        if (!r.stopped || r.removed === false) setSessionError(rollbackMessage(r));
      }),
      api.events.onSettingsChanged((s) => {
        settingsFeed.push(s as AppSettings);
        loadRoute();
      }),
      api.events.onAnswerPrefs((p) => {
        setInterviewType(p.interviewType);
        setAnswerFormat(p.format);
        setPronunciation(p.pronunciation);
        void loadSettings();
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
    void loadSettings();
    return () => {
      buf.cancel();
      cleanup.current.forEach((u) => u());
    };
  }, []);

  // Derived from the cards list (cueLayout): the ONE dominant card is
  // whichever is streaming (so regenerating an OLDER card brings it forward),
  // else the newest answered one; missed questions stay visible on their own;
  // everything else is behind "Earlier".
  const streaming = cards.some((c) => c.streaming);
  const { current, missed, earlier } = cueLayout(cards);
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
  // Changing style/pronunciation updates the active session and re-generates
  // the current question so the new form appears immediately. The style chip
  // (General | Technical) also sets the interview type behind the scenes — the
  // old TYPE dropdown is gone — but a coding session must stay coding (its
  // listen-only toggle and solver model hang off that type).
  const changeFormat = async (f: AnswerFormat) => {
    setAnswerFormat(f);
    const prefs: { format: AnswerFormat; interviewType?: InterviewType } = { format: f };
    if (interviewType !== 'coding') {
      prefs.interviewType = f === 'technical' ? 'technical' : 'general';
      setInterviewType(prefs.interviewType);
    }
    await api.session.setAnswerPrefs(prefs);
    if (question) await api.session.regenerate();
  };
  const togglePronunciation = async () => {
    const next = !pronunciation;
    setPronunciation(next);
    await api.session.setAnswerPrefs({ pronunciation: next });
    if (question) await api.session.regenerate();
  };
  // A model chip: persist the pick for THIS task only — main merges it into
  // the stored overrides, so nothing else is written from this window's copy
  // (null clears it → Automatic). Main's reply carries the re-resolved
  // routes, so the chip names what the next request will really use. Only
  // the answer task re-answers the current question: the solver applies to
  // the next solve, and re-running a spoken answer would not use it at all.
  const pickModel = async (task: PickerTask, value: string | null) => {
    try {
      await settingsFeed.request(api.settings.set({ modelOverrides: { [task]: value } }) as Promise<AppSettings>);
    } catch (e) {
      setSessionError((e as Error).message);
      return;
    }
    if (task === 'answer' && question) await api.session.regenerate();
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
  // The Cue Card's Stop. A session whose failed start is still being rolled
  // back is rolled back by main (no Keep prompt; a new one is removed) — the
  // same policy as the dashboard's Stop. Anything unconfirmed is said here.
  const stop = async () => {
    setStopping(true);
    try {
      const r = await api.session.stopActive();
      if (r.rollback && (!r.rollback.stopped || r.rollback.removed === false)) setSessionError(rollbackMessage(r.rollback));
    } catch (e) {
      setSessionError(`Stopping failed (${(e as Error).message}) — the session may still be running. Press Stop to try again.`);
    } finally {
      setStopping(false);
    }
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

  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!moreRef.current?.contains(target) && !target.closest('[aria-controls="cue-more-controls"]')) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // An inner dropdown consumes its Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', close);
    };
  }, [moreOpen]);

  // Per-region click-through. Electron ignores the mouse per-WINDOW, so making the
  // whole Cue Card click-through would trap its own buttons. Instead, while it's on
  // we flip ignore as the cursor enters/leaves the control bar — mouse-move is still
  // forwarded while ignoring ({forward:true}) — so the header stays clickable and
  // only the answer area passes clicks through to the app behind.
  useEffect(() => {
    // An open tray/dialog must receive the outside press that dismisses it;
    // forwarding that press to another app can leave controls stuck open.
    if (!clickthrough || moreOpen || settingsOpen) {
      void api.overlay.setClickthrough(false);
      return;
    }
    let ignoring = false;
    const onMove = (e: MouseEvent) => {
      const overUI = !!document.querySelector('[data-ct-popover]') || !!(
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
  }, [clickthrough, moreOpen, settingsOpen]);

  const cardProps = (c: CardModel, isCurrent: boolean) => ({
    card: c,
    isCurrent,
    live,
    paused,
    copied: copiedId === c.id,
    openCite,
    onToggleCite: setOpenCite,
    onToggleCollapsed: () => useOverlayStore.getState().toggle(c.id),
    onCopy: () => copyCard(c),
    onRegenerate: () => void regenerateCard(c),
    onRemove: () => useOverlayStore.getState().remove(c.id),
    onCorrectMemory: () => correctMemory(c),
    onForgetMemory: () => void forgetMemory(c),
  });

  return (
    <div
      className="flex h-screen flex-col bg-neutral-900 p-2.5 text-neutral-100"
      style={{ fontSize: `${fontSize}px` }}
    >
      <HeaderBar
        live={live}
        paused={paused}
        streaming={streaming}
        speaking={speaking}
        reconnecting={reconnecting}
        privacy={privacy}
        privacyUnsupported={privacyUnsupported}
        clickthrough={clickthrough}
        title={clientInfo ? clientInfo.company || clientInfo.title || null : null}
        moreOpen={moreOpen}
        stopping={stopping}
        onTogglePrivacy={() => void togglePrivacy()}
        onToggleClickthrough={() => setClickthrough((c) => !c)}
        onStop={() => void stop()}
        onToggleMore={() => setMoreOpen((m) => !m)}
      />

      {moreOpen && (
        <div ref={moreRef} id="cue-more-controls" className="shrink-0">
          <MoreTray
            live={live}
            interviewType={interviewType}
            answerFormat={answerFormat}
            pronunciation={pronunciation}
            historyEnabled={historyEnabled}
            settings={settings}
            mode={mode}
            clientInfo={clientInfo}
            onPickModel={(task, value) => void pickModel(task, value)}
            onChangeFormat={(f) => void changeFormat(f)}
            onTogglePronunciation={() => void togglePronunciation()}
            onToggleHistory={() => useOverlayStore.getState().setHistoryEnabled(!historyEnabled)}
            onClear={clearAnswer}
            onToggleMode={() => applyMode(mode === 'compact' ? 'expanded' : 'compact')}
            onOpenSettings={() => {
              setMoreOpen(false);
              setSettingsOpen(true);
            }}
          />
        </div>
      )}

      {captures.length > 0 && <CapturesPanel captures={captures} />}

      {sessionError && <ErrorBanner message={sessionError} onDismiss={() => setSessionError(null)} />}

      {/* Companion sessions: live presence dial + visible cost estimate. */}
      {live && companionStatus && <CompanionBar status={companionStatus} />}

      {/* A "live" Cue Card must mean capture is working: say exactly which
          stream is missing, and what that costs. */}
      {live && captureNotice && (
        <p
          data-ct-interactive
          className="mb-2 shrink-0 rounded-md bg-amber-900/40 px-2 py-1 text-[11px] text-amber-200"
          style={noDrag}
          role="status"
        >
          ⚠ {captureNotice}
        </p>
      )}

      {/* Coding interviews listen without auto-answering by default — a state
          worth seeing, so it stays out of the ⋯ tray. */}
      {live && interviewType === 'coding' && (
        <button
          data-ct-interactive
          type="button"
          onClick={() => setAnswerInterviewer((v) => !v)}
          style={noDrag}
          title={
            answerInterviewer
              ? 'Auto-answering the interviewer — click to go listen-only'
              : "Listen-only: transcribes but won't auto-answer (keeps your coding answer). Click to answer what the interviewer just asked."
          }
          className={`mb-2 shrink-0 self-start rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            answerInterviewer ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-amber-300 hover:text-amber-200'
          }`}
        >
          {answerInterviewer ? '🎧 Answering the interviewer' : '🔇 Listen-only'}
        </button>
      )}

      {live && mode === 'expanded' && <AudioMeter level={level} speaking={speaking} />}

      {/* The latest line of the conversation; the full transcript on demand. */}
      {(live || transcript.length > 0 || Object.keys(interims).length > 0) && (
        <TranscriptPanel lines={transcript} interims={interims} />
      )}

      {/* Missed questions — not answered, never dropped: each with why, and
          one tap to answer it now. */}
      {missed.length > 0 && (
        <ul data-ct-interactive className="mb-2 shrink-0 space-y-1" style={noDrag} aria-label="Missed questions">
          {missed.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px]">
              <span className="min-w-0 flex-1">
                <span className="font-medium text-amber-300">{missLabel(c)}:</span>{' '}
                <span className="text-neutral-200">{c.title}</span>
              </span>
              <button
                type="button"
                onClick={() => void regenerateCard(c)}
                className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-100 hover:bg-amber-500/30"
              >
                Answer it
              </button>
              <button
                type="button"
                onClick={() => useOverlayStore.getState().remove(c.id)}
                aria-label="Dismiss this missed question"
                className="shrink-0 text-neutral-500 hover:text-neutral-300"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The current question and its answer — the dominant content. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-auto" style={noDrag}>
        {!current ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-neutral-500">
            {live && !paused ? (
              <>
                <EqualizerBars />
                <span className="mt-2 text-xs">Listening… answers will appear here.</span>
              </>
            ) : live && paused ? (
              <span className="text-xs">Paused — nothing is being heard. Resume to continue.</span>
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
          <div className="cue-current">
            <ContributionCard {...cardProps(current, true)} prominent />
            {meta?.riskWarning && !meta.missed && (
              <p className="mt-1.5 rounded bg-amber-900/40 px-2 py-1 text-[11px] text-amber-300">⚠ {meta.riskWarning}</p>
            )}
            {context && (
              <DataSentPanel
                context={context}
                provider={context.sentTo ? (cloudProvider(context.sentTo.provider)?.name ?? context.sentTo.provider) : answerProvider}
                show={showData}
                onToggle={() => setShowData((s) => !s)}
              />
            )}
          </div>
        )}

        {/* Earlier cards — kept, in arrival order, one tap away. */}
        {earlier.length > 0 && (
          <div data-ct-interactive className="border-t border-white/5 pt-1.5">
            <button
              type="button"
              onClick={() => setShowEarlier((v) => !v)}
              aria-expanded={showEarlier}
              className="text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              {showEarlier ? '▾' : '▸'} Earlier ({earlier.length})
            </button>
            {showEarlier && (
              <div className="mt-1 space-y-1.5">
                {earlier.map((c) => (
                  <ContributionCard key={c.id} {...cardProps(c, false)} />
                ))}
              </div>
            )}
          </div>
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

      {/* Voice is session-independent: with nothing live a summon quick-asks
          over the default Space, so the bar renders whenever the flag is on. */}
      {FLAGS.voice && (
        <VoiceBar voice={voice} prefs={voicePrefs} level={voiceLevel} onToggleMute={() => void toggleMute()} />
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
