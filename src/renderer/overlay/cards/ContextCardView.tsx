import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A grounding/context drop: background the agent surfaced for the conversation
 *  (also renders `memory_suggestion` until Memory lands its own view). */
export function ContextCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-sky-500/50 bg-sky-500/5 px-2 py-1 leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
