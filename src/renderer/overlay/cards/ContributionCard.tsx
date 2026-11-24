import { ChevronRightIcon, CloseIcon, RefreshIcon } from '../../components/icons';
import type { CardModel } from './model';
import { cardDefinition, isKnownKind } from './registry';
import { answeredByText } from '../../lib/modelChoice';

/** The generic card frame: header (collapse toggle, title, capability-driven
 *  actions) + the kind's body view from the registry. Pure presentational —
 *  every action is a callback, so the shell owns all IPC. */
export function ContributionCard(props: {
  card: CardModel;
  isCurrent: boolean;
  live: boolean;
  paused: boolean;
  copied: boolean;
  openCite: string | null;
  onToggleCite: (k: string | null) => void;
  onToggleCollapsed: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onRemove: () => void;
  /** Memory cards (capability `memory` + meta.memoryId): correct/forget the
   *  underlying memory from the card. Wired by the shell. */
  onCorrectMemory?: () => void;
  onForgetMemory?: () => void;
  /** The live view's ONE current card: the question large, the answer always
   *  shown (never collapsed), its actions alongside. */
  prominent?: boolean;
}) {
  const { card, isCurrent } = props;
  const def = cardDefinition(card.kind);
  const memoryId = (card.meta as Record<string, unknown> | null)?.memoryId;
  // The route captured when this answer was requested — a later settings
  // change or failover never relabels it.
  const route = card.meta?.answeredBy;
  const answered = route && card.body ? answeredByText(route) : null;
  const memoryActions = !!def.capabilities.memory && typeof memoryId === 'string';
  const chip = def.chip ?? (isKnownKind(card.kind) ? null : card.kind);
  const View = def.View;
  const collapsed = card.collapsed && !props.prominent;
  return (
    <div
      className={isCurrent ? '' : 'rounded-lg border border-neutral-800 bg-neutral-950/40 px-2 py-1'}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={props.prominent ? undefined : props.onToggleCollapsed}
          aria-expanded={props.prominent ? undefined : !collapsed}
          className={`flex min-w-0 flex-1 items-start gap-1 text-left font-medium ${
            props.prominent
              ? 'cursor-default text-[13px] font-semibold leading-snug text-white'
              : 'text-xs text-blue-300 hover:text-blue-200'
          }`}
        >
          {!props.prominent && (
            <ChevronRightIcon
              className={`mt-0.5 h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
            />
          )}
          {chip != null && (
            <span className="mt-px shrink-0 rounded bg-neutral-800 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-neutral-400">
              {chip}
            </span>
          )}
          <span className={collapsed ? 'truncate' : ''}>
            {chip == null && isKnownKind(card.kind) ? `Q: ${card.title}` : card.title}
          </span>
        </button>
        {def.capabilities.copy && card.body && (
          <button
            onClick={props.onCopy}
            title="Copy answer"
            className={`shrink-0 rounded p-0.5 ${
              props.copied ? 'text-green-400' : 'text-neutral-600 hover:text-blue-300'
            }`}
          >
            <span className="text-[11px] leading-none">{props.copied ? '✓' : '⧉'}</span>
          </button>
        )}
        {def.capabilities.regenerate && (
          <button
            onClick={props.onRegenerate}
            title={def.capabilities.regenerate.tooltip}
            className="shrink-0 rounded p-0.5 text-neutral-600 hover:text-blue-300"
          >
            <RefreshIcon className="h-3 w-3" />
          </button>
        )}
        {memoryActions && (
          <>
            <button
              onClick={props.onCorrectMemory}
              title="Correct this memory"
              className="shrink-0 rounded p-0.5 text-neutral-600 hover:text-violet-300"
            >
              <span className="text-[11px] leading-none">✎</span>
            </button>
            <button
              onClick={props.onForgetMemory}
              title="Forget this memory (deletes it)"
              className="shrink-0 rounded p-0.5 text-neutral-600 hover:text-red-300"
            >
              <span className="text-[11px] leading-none">⌫</span>
            </button>
          </>
        )}
        <button
          onClick={props.onRemove}
          title="Remove this answer"
          className="shrink-0 rounded p-0.5 text-neutral-600 hover:text-red-300"
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>
      {!collapsed && (
        <View
          card={card}
          isCurrent={isCurrent}
          live={props.live}
          paused={props.paused}
          openCite={props.openCite}
          onToggleCite={props.onToggleCite}
        />
      )}
      {!collapsed && answered && (
        <p className="mt-1 text-[10px] text-neutral-500" title={answered.detail} data-answered-by>
          {answered.label}
        </p>
      )}
    </div>
  );
}
