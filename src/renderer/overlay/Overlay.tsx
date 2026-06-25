import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AnswerPrefs, ClientInfo } from '@shared/ipc';
import type {
  AnswerLength,
  AnswerMetaEvent,
  AnswerStyle,
  AppSettings,
  ContextSentEvent,
  InterviewType,
} from '@shared/types';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/ui';
import {
  BoltIcon,
  ChevronRightIcon,
  CloseIcon,
  CompactIcon,
  CursorIcon,
  ExpandIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  HeadphonesIcon,
  RefreshIcon,
  SettingsIcon,
  TrashIcon,
} from '../components/icons';

/** A transcript line in the Cue Card (mirrors the dashboard store's Line). */
interface Line {
  id: number;
  speaker: string;
  text: string;
}

// Cap transcript lines kept in the DOM — a long interview can produce thousands.
const MAX_LINES = 300;
// Mic-level thresholds for "someone is speaking" — with hysteresis (turn on at a
// higher level than it turns off) so the meter doesn't flicker on/off at the
// boundary or twitch on background noise.
const SPEAK_ON = 0.05;
const SPEAK_OFF = 0.035;

const INTERVIEW_TYPES: { value: InterviewType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'coding', label: 'Coding' },
  { value: 'system_design', label: 'System design' },
  { value: 'product', label: 'Product' },
  { value: 'sales', label: 'Sales' },
];

export default function Overlay() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [meta, setMeta] = useState<AnswerMetaEvent | null>(null);
  const [context, setContext] = useState<ContextSentEvent | null>(null);
  const [streaming, setStreaming] = useState(false);

  const [fontSize, setFontSize] = useState(14);
  const [opacity, setOpacity] = useState(0.95);
  const [mode, setMode] = useState<'compact' | 'expanded'>('compact');
  const [clickthrough, setClickthrough] = useState(false);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(false);
  const [showData, setShowData] = useState(false);
  const [privacy, setPrivacy] = useState(true);
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [showClient, setShowClient] = useState(false);
  // Live answer controls (mirrored to the active session via setAnswerPrefs).
  const [interviewType, setInterviewType] = useState<InterviewType>('general');
  const [format, setFormat] = useState<AnswerStyle>('default');
  const [length, setLength] = useState<AnswerLength>('key_points');
  const [pronunciation, setPronunciation] = useState(false);

  // Settings modal (audio device + appearance; persisted).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioSource, setAudioSource] = useState<'system' | 'mic'>('system');
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);

  // Backend session failure (transcription socket dropped, OpenAI auth, etc.).
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Manual "Ask" box (Cue Card) + audio level meter + resizable transcript.
  const [askText, setAskText] = useState('');
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false); // hysteresis over `level`
  const [transcriptHeight, setTranscriptHeight] = useState(150);

  // Live transcript (the conversation feed), so the dashboard can be minimized.
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [interim, setInterim] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const lineId = useRef(0);
  const prevLive = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const cleanup = useRef<(() => void)[]>([]);
  // Streamed tokens arrive far faster than the screen refreshes. Buffer them and
  // flush once per animation frame so the (re-parsed) markdown renders at most
  // ~60×/sec instead of once per token.
  const pendingTokens = useRef('');
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      flushHandle.current = null;
      if (!pendingTokens.current) return;
      const chunk = pendingTokens.current;
      pendingTokens.current = '';
      setAnswer((a) => a + chunk);
    };
    const scheduleFlush = () => {
      if (flushHandle.current == null) flushHandle.current = requestAnimationFrame(flush);
    };
    const cancelFlush = () => {
      if (flushHandle.current != null) cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
      pendingTokens.current = '';
    };

    cleanup.current.push(
      api.events.onQuestionDetected((p) => {
        const text = (p as { text: string }).text;
        cancelFlush();
        setQuestion(text);
        setAnswer('');
        setMeta(null);
        setContext(null);
        setStreaming(true);
        // Mirror the dashboard: surface the detected question in the transcript too.
        setTranscript((t) => [...t, { id: lineId.current++, speaker: 'detected question', text }]);
      }),
      api.events.onTranscriptDelta((p) => {
        const d = p as { text: string; speaker: string; isFinal: boolean };
        if (d.isFinal) {
          setTranscript((t) => [...t, { id: lineId.current++, speaker: d.speaker, text: d.text }]);
          setInterim('');
        } else {
          setInterim((s) => s + d.text);
        }
      }),
      api.events.onAnswerDelta((p) => {
        pendingTokens.current += (p as { token: string }).token;
        scheduleFlush();
      }),
      api.events.onAnswerMeta((p) => setMeta(p as AnswerMetaEvent)),
      api.events.onAnswerDone(() => {
        flush();
        setStreaming(false);
      }),
      // Regenerate: clear the current answer (the transcript is untouched) so the
      // re-streamed tokens don't append to the old answer.
      api.events.onAnswerReset(() => {
        cancelFlush();
        setAnswer('');
        setMeta(null);
        setContext(null);
        setStreaming(true);
      }),
      api.events.onContextSent((p) => setContext(p as ContextSentEvent)),
      api.events.onSessionError((p) =>
        setSessionError((p as { message?: string }).message || 'Session error.'),
      ),
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
          cancelFlush();
          lineId.current = 0;
          setTranscript([]);
          setInterim('');
          setQuestion('');
          setAnswer('');
          setMeta(null);
          setContext(null);
          setStreaming(false);
          setAtBottom(true);
          setSessionError(null);
        }
        // Session stopped: drop the dangling interim partial + streaming cursor so
        // the Cue Card doesn't look like it's still listening.
        if (!nowLive) {
          setInterim('');
          setStreaming(false);
          setLevel(0);
          setSpeaking(false);
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
        setFormat(p.style);
        setLength(p.length);
        setPronunciation(p.pronunciation);
      }),
      api.events.onAudioLevel((p) => {
        setLevel(p.level);
        setSpeaking((was) => (was ? p.level > SPEAK_OFF : p.level > SPEAK_ON));
      }),
    );
    void api.privacy.get().then((p) => setPrivacy((p as { enabled: boolean }).enabled));
    // Seed the audio-device controls from persisted settings.
    void api.settings.get().then((s) => {
      const a = (s as AppSettings).audio;
      if (a) {
        setAudioSource(a.source);
        setMicDeviceId(a.micDeviceId);
      }
    });
    return () => {
      if (flushHandle.current != null) cancelAnimationFrame(flushHandle.current);
      cleanup.current.forEach((u) => u());
    };
  }, []);

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
  const toggleClickthrough = () => setClickthrough((c) => !c);
  const togglePause = () => void api.session.togglePauseActive();

  // --- live answer controls ---
  // Changing type/format/length/pronunciation updates the active session and
  // re-generates the current question so the new form appears immediately.
  const changeInterviewType = async (t: InterviewType) => {
    setInterviewType(t);
    await api.session.setAnswerPrefs({ interviewType: t });
    if (question) await api.session.regenerate();
  };
  const changeFormat = async (f: AnswerStyle) => {
    setFormat(f);
    await api.session.setAnswerPrefs({ style: f });
    if (question) await api.session.regenerate();
  };
  const changeLength = async (l: AnswerLength) => {
    setLength(l);
    await api.session.setAnswerPrefs({ length: l });
    if (question) await api.session.regenerate();
  };
  const togglePronunciation = async () => {
    const next = !pronunciation;
    setPronunciation(next);
    await api.session.setAnswerPrefs({ pronunciation: next });
    if (question) await api.session.regenerate();
  };
  const regenerate = () => void api.session.regenerate();
  const clearAnswer = () => {
    if (flushHandle.current != null) {
      cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
    }
    pendingTokens.current = '';
    setQuestion('');
    setAnswer('');
    setMeta(null);
    setContext(null);
    setStreaming(false);
    void api.session.clearAnswer();
  };
  const stop = () => void api.session.stopActive();

  // --- audio device settings ---
  const openSettings = async () => {
    setSettingsOpen(true);
    try {
      // Device labels only populate after a mic-permission grant — briefly probe
      // the mic to unlock them, then release it (main auto-allows 'media').
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
      probe?.getTracks().forEach((t) => t.stop());
    } catch {
      setMicDevices([]);
    }
  };
  const saveAudio = (next: { source?: 'system' | 'mic'; micDeviceId?: string | null }) => {
    const source = next.source ?? audioSource;
    const device = next.micDeviceId !== undefined ? next.micDeviceId : micDeviceId;
    setAudioSource(source);
    setMicDeviceId(device);
    void api.settings.set({ audio: { source, micDeviceId: device } });
  };

  const sendAsk = () => {
    const t = askText.trim();
    if (!t) return;
    void api.session.askActive(t);
    setAskText('');
  };

  // Drag the bottom edge of the transcript pane to resize its height.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = transcriptHeight;
    const onMove = (ev: MouseEvent) => {
      const next = startH + (ev.clientY - startY);
      // Cap at half the window so the answer pane always keeps a usable area.
      const max = Math.max(80, Math.floor(window.innerHeight * 0.5));
      setTranscriptHeight(Math.max(60, Math.min(max, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Keep the transcript pinned to the newest line unless the user scrolled up.
  useEffect(() => {
    if (atBottom && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript, interim, atBottom]);
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
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

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const ctrlSelect =
    'rounded-md border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-[11px] normal-case text-neutral-200 outline-none';

  return (
    <div
      className="flex h-screen flex-col bg-neutral-900 p-2.5 text-neutral-100"
      style={{ fontSize: `${fontSize}px` }}
    >
      {/* Header / drag handle. Marked interactive so it stays clickable when
          click-through is on (only the answer area below passes clicks through). */}
      <div
        data-ct-interactive
        className="mb-2 flex shrink-0 items-center justify-between text-[11px] text-neutral-400"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              paused ? 'bg-amber-400' : streaming ? 'animate-pulse bg-green-400' : 'bg-neutral-600'
            }`}
          />
          <span className="truncate">
            BrainCue
            {clientInfo && (clientInfo.company || clientInfo.title)
              ? ` · ${clientInfo.company || clientInfo.title}`
              : ''}
          </span>
          {live && !paused && speaking && <EqualizerBars />}
        </span>
        <div className="flex items-center gap-0.5" style={noDrag}>
          <Btn
            active={!privacy}
            tone={privacy ? 'default' : 'warn'}
            onClick={togglePrivacy}
            title={privacy ? 'Hidden from screen share — click to reveal' : 'VISIBLE to screen share — click to hide'}
          >
            {privacy ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
          </Btn>
          <Btn active={clickthrough} onClick={toggleClickthrough} title="Click-through (mouse passes through)">
            <CursorIcon className="h-3.5 w-3.5" />
          </Btn>
          <span className="mx-0.5 h-4 w-px bg-neutral-700" />
          <Btn onClick={() => api.capture.quickSolve()} title="Solve from clipboard (Ctrl+Shift+Enter)">
            <BoltIcon className="h-3.5 w-3.5" />
          </Btn>
          <Btn onClick={() => api.capture.openSelector()} title="Solve a screen region (Ctrl+Shift+S)">
            <FrameIcon className="h-3.5 w-3.5" />
          </Btn>
          <span className="mx-0.5 h-4 w-px bg-neutral-700" />
          <Btn
            onClick={() => applyMode(mode === 'compact' ? 'expanded' : 'compact')}
            title={mode === 'compact' ? 'Expand (more controls)' : 'Compact view'}
          >
            {mode === 'compact' ? (
              <ExpandIcon className="h-3.5 w-3.5" />
            ) : (
              <CompactIcon className="h-3.5 w-3.5" />
            )}
          </Btn>
          <Btn onClick={openSettings} title="Settings (audio device, appearance)">
            <SettingsIcon className="h-3.5 w-3.5" />
          </Btn>
          {clientInfo && (
            <Btn
              active={showClient}
              onClick={() => setShowClient((s) => !s)}
              title="Profile & interview details"
            >
              <span className="text-[12px] font-bold leading-none">ⓘ</span>
            </Btn>
          )}
          <Btn onClick={() => api.overlay.hide()} title="Hide Cue Card">
            <CloseIcon className="h-3.5 w-3.5" />
          </Btn>
        </div>
      </div>

      {/* Client notes (toggled by the ⓘ button) */}
      {showClient && clientInfo && (
        <div
          className="mb-2 max-h-32 overflow-auto rounded-lg border border-neutral-700 bg-neutral-950/80 p-2 text-[11px]"
          style={noDrag}
        >
          <div className="mb-1 font-semibold text-neutral-200">
            {clientInfo.company || clientInfo.title || 'Client'}
            {clientInfo.company && clientInfo.title ? ` · ${clientInfo.title}` : ''}
          </div>
          {clientInfo.notes ? (
            <p className="whitespace-pre-wrap leading-relaxed text-neutral-300">{clientInfo.notes}</p>
          ) : (
            <p className="text-neutral-500">No notes saved for this client.</p>
          )}
        </div>
      )}

      {/* Backend session failure — surfaced so the Cue Card never silently shows a
          "listening" state after the transcription socket / OpenAI call has failed. */}
      {sessionError && (
        <div
          data-ct-interactive
          className="mb-2 flex shrink-0 items-start justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/15 px-2 py-1 text-[11px] text-red-300"
          style={noDrag}
        >
          <span className="min-w-0">⚠ {sessionError}</span>
          <button
            onClick={() => setSessionError(null)}
            className="shrink-0 text-red-300/70 hover:text-red-200"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Session bar: which profile is answering + grounding sources, and the
          Pause/Stop controls. The interview title shows in the header. */}
      {live && (
        <div
          data-ct-interactive
          className="mb-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
          style={noDrag}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-neutral-400">
            <span className="truncate">👤 {clientInfo?.profileName ?? 'No profile'}</span>
            {clientInfo?.hasResume && (
              <span className="rounded bg-green-900/40 px-1 py-px text-[10px] text-green-300">résumé ✓</span>
            )}
            {clientInfo?.hasJd && (
              <span className="rounded bg-green-900/40 px-1 py-px text-[10px] text-green-300">JD ✓</span>
            )}
            {clientInfo?.hasCompany && (
              <span className="rounded bg-blue-900/40 px-1 py-px text-[10px] text-blue-300">company ✓</span>
            )}
          </span>
          <span className="flex-1" />
          <button
            onClick={togglePause}
            className="rounded-md bg-neutral-800 px-2 py-1 font-medium text-neutral-200 transition-colors hover:bg-neutral-700"
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            onClick={stop}
            className="rounded-md bg-red-600/90 px-2 py-1 font-medium text-white transition-colors hover:bg-red-600"
          >
            ■ Stop
          </button>
        </div>
      )}

      {/* Answer controls (labeled): interview type, format, length, pronunciation,
          regenerate, clear. All dynamic — change them anytime mid-interview. */}
      {live && (
        <div
          data-ct-interactive
          className="mb-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1"
          style={noDrag}
        >
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
            Type
            <select
              value={interviewType}
              onChange={(e) => changeInterviewType(e.target.value as InterviewType)}
              className={ctrlSelect}
            >
              {INTERVIEW_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
            Format
            <select
              value={format}
              onChange={(e) => changeFormat(e.target.value as AnswerStyle)}
              className={ctrlSelect}
            >
              <option value="default">Default</option>
              <option value="conversational">Conversational</option>
              <option value="star">STAR</option>
              <option value="technical">Technical</option>
            </select>
          </label>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
            Length
            <span className="flex overflow-hidden rounded-md ring-1 ring-neutral-700">
              <button
                onClick={() => changeLength('key_points')}
                title="Short, key-point-focused answers"
                className={`px-2 py-1 text-[11px] font-medium normal-case transition-colors ${
                  length === 'key_points'
                    ? 'bg-blue-600 text-white'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Key points
              </button>
              <button
                onClick={() => changeLength('detailed')}
                title="Thorough, very detailed answers"
                className={`px-2 py-1 text-[11px] font-medium normal-case transition-colors ${
                  length === 'detailed'
                    ? 'bg-blue-600 text-white'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Detailed
              </button>
            </span>
          </span>
          <span className="flex-1" />
          <Btn
            active={pronunciation}
            onClick={togglePronunciation}
            title="Pronunciation hints for rare / technical words"
          >
            <span className="text-[12px] font-semibold leading-none">æ</span>
          </Btn>
          <Btn onClick={regenerate} title="Regenerate this answer">
            <RefreshIcon className="h-3.5 w-3.5" />
          </Btn>
          <Btn onClick={clearAnswer} title="Clear the answer">
            <TrashIcon className="h-3.5 w-3.5" />
          </Btn>
        </div>
      )}

      {/* Audio meter (expanded) — driven by a level broadcast from main. It only
          animates while someone is actually speaking; otherwise it sits flat so it
          doesn't twitch on background noise. */}
      {live && mode === 'expanded' && (
        <div
          data-ct-interactive
          className="mb-2 flex h-5 shrink-0 items-end gap-0.5"
          style={noDrag}
          title={speaking ? 'Speaking…' : 'Quiet'}
        >
          {[0.6, 0.85, 1, 0.7, 0.95, 0.6, 0.8].map((m, i) => (
            <span
              key={i}
              className={`w-1 rounded-sm transition-[height] duration-75 ${
                speaking ? 'bg-green-500/80' : 'bg-neutral-700'
              }`}
              style={{ height: `${speaking ? Math.max(8, Math.min(100, level * 320 * m)) : 8}%` }}
            />
          ))}
        </div>
      )}

      {/* Live transcript — resizable height (drag the handle below). Lets the
          dashboard be minimized during the interview. */}
      {(live || transcript.length > 0 || interim) && (
        <>
        <div
          data-ct-interactive
          className="relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950/50"
          style={{ ...noDrag, height: transcriptHeight }}
        >
          <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500">
            <span>Transcript</span>
            {transcript.length > MAX_LINES && <span>last {MAX_LINES}</span>}
          </div>
          <div
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
            className="flex-1 space-y-1 overflow-y-auto px-2 pb-2 text-[11px] leading-snug"
          >
            {transcript.length === 0 && !interim ? (
              <p className="text-neutral-600">Listening… the conversation will appear here.</p>
            ) : (
              <>
                {transcript.slice(-MAX_LINES).map((l) => (
                  <p key={l.id}>
                    <span
                      className={
                        l.speaker === 'detected question' ? 'text-blue-400' : 'text-neutral-500'
                      }
                    >
                      {l.speaker}:{' '}
                    </span>
                    <span className="text-neutral-300">{l.text}</span>
                  </p>
                ))}
                {interim && (
                  <p className="italic text-neutral-500">
                    interviewer: {interim}
                    <span className="ml-0.5 animate-pulse">▋</span>
                  </p>
                )}
              </>
            )}
          </div>
          {!atBottom && (
            <button
              type="button"
              onClick={() => {
                const el = transcriptRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setAtBottom(true);
              }}
              className="absolute bottom-1 right-2 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white shadow hover:bg-blue-500"
            >
              ↓ latest
            </button>
          )}
        </div>
        {/* Resize handle — drag to change the transcript height. */}
        <div
          data-ct-interactive
          onMouseDown={startResize}
          title="Drag to resize the transcript"
          className="mb-2 mt-0.5 h-1.5 shrink-0 cursor-row-resize rounded bg-neutral-800 transition-colors hover:bg-neutral-600"
          style={noDrag}
        />
        </>
      )}

      {question && <p className="mb-1 shrink-0 text-xs font-medium text-blue-300">Q: {question}</p>}

      {/* Answer (fills the remaining space) */}
      <div className="min-h-0 flex-1 overflow-auto leading-relaxed" style={noDrag}>
        {answer ? (
          <Markdown>{answer}</Markdown>
        ) : (
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
                  the transcript & suggested answers stream here.
                </span>
              </>
            )}
          </div>
        )}
        {streaming && <span className="ml-0.5 animate-pulse">▋</span>}
      </div>

      {/* Manual Ask — type a question (handy when auto-detection misses one, or to
          test grounded answering). Available whenever a session is live. */}
      {live && (
        <div data-ct-interactive className="mt-2 flex shrink-0 gap-1" style={noDrag}>
          <input
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendAsk()}
            placeholder="Ask a question…"
            className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-indigo-500"
          />
          <button
            onClick={sendAsk}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            Ask
          </button>
        </div>
      )}

      {/* Talking points + resume match (expanded mode) */}
      {mode === 'expanded' && meta && (
        <div className="mt-2 shrink-0 space-y-1.5 border-t border-neutral-800 pt-2 text-xs" style={noDrag}>
          {meta.talkingPoints.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-neutral-300">
              {meta.talkingPoints.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          {meta.resumeMatch && (
            <p className="text-neutral-400">
              <span className="text-neutral-500">Resume: </span>
              {meta.resumeMatch}
            </p>
          )}
          {meta.followupQuestion && (
            <p className="text-neutral-400">
              <span className="text-neutral-500">Ask back: </span>
              {meta.followupQuestion}
            </p>
          )}
        </div>
      )}

      {meta?.riskWarning && (
        <p className="mt-2 shrink-0 rounded bg-amber-900/40 px-2 py-1 text-[11px] text-amber-300" style={noDrag}>
          ⚠ {meta.riskWarning}
        </p>
      )}

      {/* Transparency: what was sent to OpenAI */}
      {context && (
        <div className="mt-2 shrink-0 text-[11px]" style={noDrag}>
          <button
            onClick={() => setShowData((s) => !s)}
            className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-300"
          >
            <ChevronRightIcon
              className={`h-3 w-3 transition-transform ${showData ? 'rotate-90' : ''}`}
            />
            Data sent to OpenAI ({context.chunks.length} chunks)
          </button>
          {showData && (
            <div className="mt-1 max-h-28 space-y-1 overflow-auto rounded bg-neutral-950/60 p-2 text-neutral-400">
              {context.chunks.length === 0 ? (
                <p>No profile context matched — answer is general/transferable.</p>
              ) : (
                context.chunks.map((c) => (
                  <p key={c.id}>
                    <span className="text-neutral-600">[{c.sourceType} · {c.score.toFixed(2)}] </span>
                    {c.content.slice(0, 140)}
                    {c.content.length > 140 ? '…' : ''}
                  </p>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Audio device settings. Wrapped in a ct-interactive container so it stays
          clickable even when click-through is on. */}
      <div data-ct-interactive style={noDrag}>
        <Modal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="Cue Card settings"
          width="max-w-sm"
        >
          <div className="space-y-5 text-sm">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Audio</p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-400">Listen to</span>
                <select
                  value={audioSource}
                  onChange={(e) => saveAudio({ source: e.target.value as 'system' | 'mic' })}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500"
                >
                  <option value="system">Interviewer (system audio)</option>
                  <option value="mic">Microphone (in-person)</option>
                </select>
              </label>
              {audioSource === 'mic' && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-400">Microphone</span>
                  <select
                    value={micDeviceId ?? ''}
                    onChange={(e) => saveAudio({ micDeviceId: e.target.value || null })}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500"
                  >
                    <option value="">System default</option>
                    {micDevices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="text-xs text-neutral-500">
                Applies to your next interview (the running one keeps its device).
                {audioSource === 'mic' && micDevices.every((d) => !d.label)
                  ? ' Grant microphone access once to see device names.'
                  : ''}
              </p>
            </div>

            <div className="space-y-3 border-t border-white/5 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Appearance
              </p>
              <label className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-neutral-400">Opacity</span>
                <input
                  type="range"
                  min={0.4}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => applyOpacity(Number(e.target.value))}
                  className="h-1 flex-1 accent-indigo-500"
                />
              </label>
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-neutral-400">Text size</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setFontSize((f) => Math.max(10, f - 1))}
                    className="rounded-md bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-neutral-200 hover:bg-neutral-700"
                  >
                    A−
                  </button>
                  <span className="w-8 text-center text-xs tabular-nums text-neutral-400">
                    {fontSize}px
                  </span>
                  <button
                    onClick={() => setFontSize((f) => Math.min(28, f + 1))}
                    className="rounded-md bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-neutral-200 hover:bg-neutral-700"
                  >
                    A+
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}

function EqualizerBars() {
  return (
    <span className="flex h-4 items-end gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="eq-bar" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}

function Btn(props: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'default' | 'warn' | 'danger';
  title?: string;
}) {
  const base =
    'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 transition-colors';
  const tone =
    props.tone === 'warn'
      ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
      : props.tone === 'danger'
        ? 'text-red-400 hover:bg-red-500/20 hover:text-red-300'
        : props.active
          ? 'bg-neutral-700 text-white'
          : 'text-neutral-400 hover:bg-neutral-700/70 hover:text-neutral-200';
  return (
    <button title={props.title} onClick={props.onClick} className={`${base} ${tone}`}>
      {props.children}
    </button>
  );
}
