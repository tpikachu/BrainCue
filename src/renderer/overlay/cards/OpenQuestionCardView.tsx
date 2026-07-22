import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** Something the conversation left unresolved — worth circling back to. */
export function OpenQuestionCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border-l-2 border-violet-500/50 bg-violet-500/5 px-2 py-1 italic leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
