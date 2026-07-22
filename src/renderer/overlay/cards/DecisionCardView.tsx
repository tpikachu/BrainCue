import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A settled choice the meeting made — quoted from the transcript. */
export function DecisionCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-fuchsia-500/50 bg-fuchsia-500/5 px-2 py-1 leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
