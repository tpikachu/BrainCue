import type { CardViewProps } from './registry';

/** Safe fallback for a contribution kind this build doesn't know (a newer main
 *  process, a future mode). Renders the body as plain text — never crashes the
 *  Cue Card over an unrecognized kind. */
export function UnknownCardView({ card }: CardViewProps) {
  return (
    <div className="mt-0.5 rounded border border-dashed border-neutral-700 bg-neutral-950/40 px-2 py-1 leading-relaxed">
      <p className="whitespace-pre-wrap text-neutral-300">{card.body}</p>
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
    </div>
  );
}
