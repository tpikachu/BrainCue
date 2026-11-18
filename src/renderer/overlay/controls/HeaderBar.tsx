import type React from 'react';
import { api } from '../../lib/api';
import { CloseIcon, CursorIcon, EyeIcon, EyeOffIcon } from '../../components/icons';
import { noDrag } from '../lib/style';
import { Btn } from './Btn';
import { EqualizerBars } from './EqualizerBars';

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
 * NOTE: the ⏸/▶/■ labels are frozen selectors (the privacy hard test
 * matches /Stop|Pause/).
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
      className="mb-2 flex shrink-0 items-center justify-between gap-2 text-[11px] text-neutral-400"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
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
        <span className={`shrink-0 font-medium ${props.paused || props.reconnecting ? 'text-amber-300' : props.live ? 'text-neutral-200' : ''}`}>
          {status}
        </span>
        {props.title && <span className="truncate text-neutral-500">· {props.title}</span>}
        {props.live && !props.paused && props.speaking && <EqualizerBars />}
      </span>
      <div className="flex shrink-0 items-center gap-0.5" style={noDrag}>
        <Btn
          active={!props.privacy || props.privacyUnsupported}
          tone={props.privacy && !props.privacyUnsupported ? 'default' : 'warn'}
          onClick={props.onTogglePrivacy}
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
        <Btn active={props.clickthrough} onClick={props.onToggleClickthrough} title="Click-through (mouse passes through) — Ctrl+Shift+\">
          <CursorIcon className="h-3.5 w-3.5" />
        </Btn>
        {props.live && (
          <>
            <span className="mx-0.5 h-4 w-px bg-neutral-700" />
            <button
              type="button"
              onClick={() => void api.session.togglePauseActive()}
              className="rounded-md bg-neutral-800 px-2 py-0.5 font-medium text-neutral-200 transition-colors hover:bg-neutral-700"
            >
              {props.paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              type="button"
              onClick={props.onStop}
              disabled={props.stopping}
              className="rounded-md bg-red-600/90 px-2 py-0.5 font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              ■ Stop
            </button>
          </>
        )}
        <span className="mx-0.5 h-4 w-px bg-neutral-700" />
        <Btn active={props.moreOpen} expanded={props.moreOpen} controls="cue-more-controls" onClick={props.onToggleMore} title={props.moreOpen ? 'Hide more' : 'More: answer style, model, capture, view, settings'}>
          <span className="text-[12px] font-semibold leading-none">⋯</span>
        </Btn>
        <Btn onClick={() => api.overlay.hide()} title="Hide Cue Card">
          <CloseIcon className="h-3.5 w-3.5" />
        </Btn>
      </div>
    </div>
  );
}
