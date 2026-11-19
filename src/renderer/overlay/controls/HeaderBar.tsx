import type React from 'react';
import { api } from '../../lib/api';
import { CloseIcon, CursorIcon, EyeIcon, EyeOffIcon, PauseIcon, PlayIcon } from '../../components/icons';
import { noDrag } from '../lib/style';
import { Btn } from './Btn';

/** What the session is doing right now, in one or two words. */
export function liveStatus(p: { live: boolean; paused: boolean; streaming: boolean; reconnecting: boolean }): string {
  if (!p.live) return 'Not live';
  if (p.paused) return 'Paused';
  if (p.reconnecting) return 'Reconnecting audio…';
  if (p.streaming) return 'Answering';
  return 'Listening';
}

/**
 * Header / drag handle: what the session is doing, and the few controls a
 * live call needs at a glance — Privacy, click-through, Pause/Resume, Stop —
 * plus "More" for everything else (style, model, capture tools, view,
 * settings, profile details). Marked interactive so it stays clickable when
 * click-through is on (only the answer area passes clicks through).
 *
 * The accessible Pause/Resume/Stop names stay stable while SVG icons replace
 * platform-dependent glyphs in the visible toolbar.
 */
export function HeaderBar(props: {
  live: boolean;
  paused: boolean;
  streaming: boolean;
  speaking: boolean;
  reconnecting: boolean;
  privacy: boolean;
  privacyUnsupported: boolean;
  clickthrough: boolean;
  /** The role/company, when the session has one. */
  title: string | null;
  moreOpen: boolean;
  stopping: boolean;
  onTogglePrivacy: () => void;
  onToggleClickthrough: () => void;
  onStop: () => void;
  onToggleMore: () => void;
}) {
  const status = liveStatus(props);
  return (
    <div
      data-ct-interactive
      data-cue-toolbar
      className="mb-2 flex min-h-12 shrink-0 items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-neutral-950/50 px-2 py-1.5 text-[11px] text-neutral-400"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="min-w-0 flex-1 leading-tight" role="status" aria-live="polite">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              !props.live
                ? 'bg-neutral-600'
                : props.paused || props.reconnecting
                  ? 'bg-amber-400'
                  : props.streaming
                    ? 'animate-pulse bg-green-400'
                    : 'bg-green-500'
            }`}
            aria-hidden
          />
          <span className={`truncate font-medium ${props.paused || props.reconnecting ? 'text-amber-300' : props.live ? 'text-neutral-200' : ''}`}>
            {status}
          </span>
        </span>
        {props.title && <p className="mt-1 truncate pl-3 text-[10px] text-neutral-500">{props.title}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1" style={noDrag} role="group" aria-label="Session controls">
        <div className="flex items-center rounded-lg bg-white/[0.03]">
          <Btn
            active={!props.privacy || props.privacyUnsupported}
            tone={props.privacy && !props.privacyUnsupported ? 'default' : 'warn'}
            onClick={props.onTogglePrivacy}
            pressed={props.privacy && !props.privacyUnsupported}
            title={
              props.privacyUnsupported
                ? 'Privacy Mode has NO effect on Linux — this window IS visible to screen shares'
                : props.privacy
                  ? 'Hidden from screen share — click to reveal'
                  : 'VISIBLE to screen share — click to hide'
            }
          >
            {props.privacy && !props.privacyUnsupported ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
          </Btn>
          <Btn active={props.clickthrough} pressed={props.clickthrough} onClick={props.onToggleClickthrough} title="Click-through (mouse passes through) — Ctrl+Shift+\">
            <CursorIcon className="h-3.5 w-3.5" />
          </Btn>
        </div>
        {props.live && (
          <>
            <button
              type="button"
              aria-label={props.paused ? '▶ Resume' : '⏸ Pause'}
              onClick={() => void api.session.togglePauseActive()}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/[0.07] px-2 font-medium text-neutral-200 outline-none transition-colors hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {props.paused ? <PlayIcon className="h-3 w-3" /> : <PauseIcon className="h-3 w-3" />}
              {props.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              aria-label="■ Stop"
              onClick={props.onStop}
              disabled={props.stopping}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-red-400/15 bg-red-500/10 px-2 font-medium text-red-300 outline-none transition-colors hover:bg-red-500/20 focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50"
            >
              <span className="h-2 w-2 rounded-sm bg-current" aria-hidden />
              Stop
            </button>
          </>
        )}
        <Btn active={props.moreOpen} expanded={props.moreOpen} controls="cue-more-controls" onClick={props.onToggleMore} title={props.moreOpen ? 'Hide more' : 'More: answer style, model, capture, view, settings'}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden><circle cx="4" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="16" cy="10" r="1.4" /></svg>
        </Btn>
        <Btn onClick={() => api.overlay.hide()} title="Hide Cue Card">
          <CloseIcon className="h-3.5 w-3.5" />
        </Btn>
      </div>
    </div>
  );
}
