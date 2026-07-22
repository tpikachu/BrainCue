import type React from 'react';
import { api } from '../../lib/api';
import type { ClientInfo } from '@shared/ipc';
import {
  BoltIcon,
  CloseIcon,
  CompactIcon,
  CursorIcon,
  ExpandIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  SettingsIcon,
} from '../../components/icons';
import { noDrag } from '../lib/style';
import { Btn } from './Btn';
import { EqualizerBars } from './EqualizerBars';

/** Header / drag handle: status dot, title, and the window-level buttons
 *  (privacy, click-through, solve/capture, compact/expanded, settings, info,
 *  hide). Marked interactive so it stays clickable when click-through is on
 *  (only the answer area below passes clicks through). */
export function HeaderBar(props: {
  paused: boolean;
  streaming: boolean;
  live: boolean;
  speaking: boolean;
  reconnecting: boolean;
  privacy: boolean;
  privacyUnsupported: boolean;
  clickthrough: boolean;
  mode: 'compact' | 'expanded';
  clientInfo: ClientInfo | null;
  showClient: boolean;
  onTogglePrivacy: () => void;
  onToggleClickthrough: () => void;
  onToggleMode: () => void;
  onOpenSettings: () => void;
  onToggleClient: () => void;
}) {
  const { clientInfo } = props;
  return (
    <div
      data-ct-interactive
      className="mb-2 flex shrink-0 items-center justify-between text-[11px] text-neutral-400"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            props.paused
              ? 'bg-amber-400'
              : props.streaming
                ? 'animate-pulse bg-green-400'
                : 'bg-neutral-600'
          }`}
        />
        <span className="truncate">
          BrainCue
          {clientInfo && (clientInfo.company || clientInfo.title)
            ? ` · ${clientInfo.company || clientInfo.title}`
            : ''}
        </span>
        {props.live && !props.paused && props.speaking && <EqualizerBars />}
        {props.live && props.reconnecting && (
          <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-300">
            reconnecting audio…
          </span>
        )}
      </span>
      <div className="flex items-center gap-0.5" style={noDrag}>
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
          {props.privacy && !props.privacyUnsupported ? (
            <EyeOffIcon className="h-3.5 w-3.5" />
          ) : (
            <EyeIcon className="h-3.5 w-3.5" />
          )}
        </Btn>
        <Btn
          active={props.clickthrough}
          onClick={props.onToggleClickthrough}
          title="Click-through (mouse passes through)"
        >
          <CursorIcon className="h-3.5 w-3.5" />
        </Btn>
        <span className="mx-0.5 h-4 w-px bg-neutral-700" />
        <Btn onClick={() => api.capture.quickSolve()} title="Solve from clipboard (Ctrl+Shift+Enter)">
          <BoltIcon className="h-3.5 w-3.5" />
        </Btn>
        <Btn
          onClick={() => api.capture.openSelector()}
          title="Capture the problem (scroll & repeat for long ones, then Solve)"
        >
          <FrameIcon className="h-3.5 w-3.5" />
        </Btn>
        <span className="mx-0.5 h-4 w-px bg-neutral-700" />
        <Btn
          onClick={props.onToggleMode}
          title={props.mode === 'compact' ? 'Expand (more controls)' : 'Compact view'}
        >
          {props.mode === 'compact' ? (
            <ExpandIcon className="h-3.5 w-3.5" />
          ) : (
            <CompactIcon className="h-3.5 w-3.5" />
          )}
        </Btn>
        <Btn onClick={props.onOpenSettings} title="Settings (audio device, appearance)">
          <SettingsIcon className="h-3.5 w-3.5" />
        </Btn>
        {clientInfo && (
          <Btn
            active={props.showClient}
            onClick={props.onToggleClient}
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
  );
}
