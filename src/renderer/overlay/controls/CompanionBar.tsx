import { api } from '../../lib/api';
import { Dropdown } from '../../components/ui';
import { noDrag } from '../lib/style';
import type { CompanionPresence, CompanionStatusEvent } from '@shared/types';

const PRESENCE_LABELS: { value: CompanionPresence; label: string }[] = [
  { value: 'off', label: 'Off (muted)' },
  { value: 'on_demand', label: 'On demand' },
  { value: 'assistive', label: 'Assistive' },
  { value: 'proactive', label: 'Proactive' },
];

/**
 * Companion session controls in the Cue Card: the live presence dial (Off is
 * the hard mute — all automatic contributions stop instantly) and the visible
 * cost estimate against the session budget. Status comes from main on
 * EVENTS.companionStatus; the select round-trips through session:set-presence.
 */
export function CompanionBar(props: { status: CompanionStatusEvent }) {
  const { presence, cost } = props.status;
  const dollars = (cost.estCents / 100).toFixed(2);
  const budget = cost.budgetCents !== null ? (cost.budgetCents / 100).toFixed(2) : null;
  return (
    <div
      data-ct-interactive
      className="mt-2 flex shrink-0 items-center gap-2 text-[11px]"
      style={noDrag}
      aria-label="Companion controls"
    >
      <span className="text-neutral-500">Companion</span>
      {/* Dropdown (not a native <select>): a native option popup is a separate
          OS window that screen shares CAN see even in Privacy Mode, and it does
          not dismiss reliably over the always-on-top Cue Card. */}
      <Dropdown
        value={presence}
        options={PRESENCE_LABELS}
        onChange={(v) => void api.session.setPresence(v)}
        buttonClassName="flex items-center justify-between gap-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-200 outline-none focus:border-indigo-500"
      />
      <span className="flex-1" />
      <span
        title={`${cost.calls} model calls · estimate, not billing`}
        className={
          cost.exhausted
            ? 'rounded bg-red-900/50 px-1.5 py-0.5 font-medium text-red-300'
            : cost.warned
              ? 'rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300'
              : 'text-neutral-500'
        }
      >
        {cost.exhausted
          ? `Budget reached ($${budget}) — quiet until you ask`
          : `~$${dollars}${budget ? ` / $${budget}` : ''}`}
      </span>
    </div>
  );
}
