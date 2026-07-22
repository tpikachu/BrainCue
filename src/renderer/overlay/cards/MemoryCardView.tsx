import { Markdown } from '../../components/Markdown';
import type { CardViewProps } from './registry';

/** A remembered fact the companion surfaced. Shows WHY it was recalled (the
 *  matched turn, stamped into meta by the mode) so recall is never opaque;
 *  the correct/forget actions live in the card frame (capability `memory`). */
export function MemoryCardView({ card }: CardViewProps) {
  const meta = (card.meta ?? {}) as Record<string, unknown>;
  const why = typeof meta.why === 'string' ? meta.why : null;
  const category = typeof meta.category === 'string' ? meta.category : null;
  return (
    <div className="mt-0.5 rounded border-l-2 border-violet-500/50 bg-violet-500/5 px-2 py-1 leading-relaxed">
      <Markdown>{card.body}</Markdown>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
      {(why || category) && (
        <p className="mt-1 text-[10px] leading-snug text-violet-300/70">
          {category && <span className="mr-1.5 rounded bg-violet-500/15 px-1 py-px uppercase tracking-wide">{category}</span>}
          {why}
        </p>
      )}
    </div>
  );
}
