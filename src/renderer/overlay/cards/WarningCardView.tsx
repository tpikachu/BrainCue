import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A caution the agent raised (a risky claim, a contradiction, a red flag). */
export function WarningCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 leading-relaxed text-amber-200">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
