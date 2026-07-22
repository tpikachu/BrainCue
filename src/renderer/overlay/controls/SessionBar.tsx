import { api } from '../../lib/api';
import type { ClientInfo } from '@shared/ipc';
import { noDrag } from '../lib/style';

/** Session bar: which profile is answering + grounding sources, and the
 *  Pause/Stop controls. NOTE: the ⏸/▶/■ button labels are frozen e2e
 *  selectors (the privacy hard test matches /Stop|Pause/). */
export function SessionBar(props: { clientInfo: ClientInfo | null; paused: boolean }) {
  const { clientInfo } = props;
  return (
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
        onClick={() => void api.session.togglePauseActive()}
        className="rounded-md bg-neutral-800 px-2 py-1 font-medium text-neutral-200 transition-colors hover:bg-neutral-700"
      >
        {props.paused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button
        onClick={() => void api.session.stopActive()}
        className="rounded-md bg-red-600/90 px-2 py-1 font-medium text-white transition-colors hover:bg-red-600"
      >
        ■ Stop
      </button>
    </div>
  );
}
