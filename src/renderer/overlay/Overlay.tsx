import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AnswerMetaEvent, ContextSentEvent } from '@shared/types';
import { Markdown } from '../components/Markdown';
import {
  ChevronRightIcon,
  CloseIcon,
  CompactIcon,
  CursorIcon,
  ExpandIcon,
  EyeIcon,
  EyeOffIcon,
  HeadphonesIcon,
  PauseIcon,
  PlayIcon,
} from '../components/icons';

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
        cancelFlush();
        setQuestion((p as { text: string }).text);
        setAnswer('');
        setMeta(null);
        setContext(null);
        setStreaming(true);
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
      api.events.onContextSent((p) => setContext(p as ContextSentEvent)),
      api.events.onSessionState((p) => {
        const s = p as { paused: boolean; status: string };
        setPaused(s.paused);
        setLive(s.status === 'live');
      }),
      api.events.onOverlayApplySettings((p) => {
        const s = p as { opacity: number; fontSize: number; mode: 'compact' | 'expanded' };
        setOpacity(s.opacity);
        setFontSize(s.fontSize);
        setMode(s.mode);
      }),
      api.events.onPrivacyChanged((p) => setPrivacy((p as { enabled: boolean }).enabled)),
    );
    void api.privacy.get().then((p) => setPrivacy((p as { enabled: boolean }).enabled));
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
  const toggleClickthrough = () => {
    const next = !clickthrough;
    setClickthrough(next);
    void api.overlay.setClickthrough(next);
  };
  const togglePause = () => void api.session.togglePauseActive();

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <div
      className="flex h-screen flex-col bg-neutral-900 p-2.5 text-neutral-100"
      style={{ fontSize: `${fontSize}px` }}
    >
      {/* Header / drag handle */}
      <div
        className="mb-2 flex items-center justify-between text-[11px] text-neutral-400"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              paused ? 'bg-amber-400' : streaming ? 'animate-pulse bg-green-400' : 'bg-neutral-600'
            }`}
          />
          AI Assistant
          {live && !paused && !streaming && <EqualizerBars />}
        </span>
        <div className="flex items-center gap-0.5" style={noDrag}>
          <Btn onClick={() => setFontSize((f) => Math.max(10, f - 1))} title="Smaller text">
            <span className="text-[11px] font-semibold leading-none">A−</span>
          </Btn>
          <Btn onClick={() => setFontSize((f) => Math.min(28, f + 1))} title="Larger text">
            <span className="text-[13px] font-semibold leading-none">A+</span>
          </Btn>
          <span className="mx-0.5 h-4 w-px bg-neutral-700" />
          <Btn active={mode === 'compact'} onClick={() => applyMode('compact')} title="Compact view">
            <CompactIcon className="h-3.5 w-3.5" />
          </Btn>
          <Btn active={mode === 'expanded'} onClick={() => applyMode('expanded')} title="Expanded view">
            <ExpandIcon className="h-3.5 w-3.5" />
          </Btn>
          <span className="mx-0.5 h-4 w-px bg-neutral-700" />
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
          <Btn active={paused} onClick={togglePause} title={paused ? 'Resume AI' : 'Pause AI'}>
            {paused ? <PlayIcon className="h-3.5 w-3.5" /> : <PauseIcon className="h-3.5 w-3.5" />}
          </Btn>
          <Btn onClick={() => api.overlay.hide()} title="Hide overlay">
            <CloseIcon className="h-3.5 w-3.5" />
          </Btn>
        </div>
      </div>

      {/* Opacity slider */}
      <div className="mb-2 flex items-center gap-2 text-[11px] text-neutral-500" style={noDrag}>
        <span>opacity</span>
        <input
          type="range"
          min={0.4}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => applyOpacity(Number(e.target.value))}
          className="h-1 flex-1 accent-blue-500"
        />
      </div>

      {question && <p className="mb-1 shrink-0 text-xs font-medium text-blue-300">Q: {question}</p>}

      {/* Answer */}
      <div className="min-h-[40px] flex-1 overflow-auto leading-relaxed" style={noDrag}>
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
                  Ready. Start a Live Session or use the “Ask” box —
                  <br />
                  suggested answers will stream here.
                </span>
              </>
            )}
          </div>
        )}
        {streaming && <span className="ml-0.5 animate-pulse">▋</span>}
      </div>

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
  tone?: 'default' | 'warn';
  title?: string;
}) {
  const base =
    'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 transition-colors';
  const tone =
    props.tone === 'warn'
      ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
      : props.active
        ? 'bg-neutral-700 text-white'
        : 'text-neutral-400 hover:bg-neutral-700/70 hover:text-neutral-200';
  return (
    <button title={props.title} onClick={props.onClick} className={`${base} ${tone}`}>
      {props.children}
    </button>
  );
}
