import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** Something to do after (or during) the conversation. */
export function ActionItemCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-emerald-500/50 bg-emerald-500/5 px-2 py-1 leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
