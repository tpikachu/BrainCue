import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A question the user could ask next (interviewer-assist / meeting modes;
 *  also renders `tutor_prompt` until Tutor lands its own view). */
export function SuggestedQuestionCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-indigo-500/50 bg-indigo-500/5 px-2 py-1 leading-relaxed">
      <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-300">
        You could ask
      </p>
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
