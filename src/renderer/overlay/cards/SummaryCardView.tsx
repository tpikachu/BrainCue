import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A rolling or final summary of the conversation (also renders `coverage`
 *  until Interviewer Assist lands its own view). */
export function SummaryCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-neutral-500/50 bg-neutral-500/5 px-2 py-1 leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
