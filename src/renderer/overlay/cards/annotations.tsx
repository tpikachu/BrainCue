import { useState } from 'react';
import { STORY_CUE_MIN_SCORE } from '@shared/types';
import type { CardModel } from './model';

/** The best-matching STAR story from the user's Story Bank for this question (a
 *  `story` chunk in the retrieved context), surfaced as a glanceable "Story to tell"
 *  cue that expands to the full STAR. Shown only when a story matched strongly enough. */
export function StoryCue({ card }: { card: CardModel }) {
  const [open, setOpen] = useState(false);
  const chunks = card.context?.chunks;
  if (!chunks) return null;
  const best = chunks
    .filter((c) => c.sourceType === 'story' && c.score >= STORY_CUE_MIN_SCORE)
    .reduce<(typeof chunks)[number] | null>((b, c) => (!b || c.score > b.score ? c : b), null);
  if (!best) return null;
  const [title, ...body] = best.content.split('\n');
  return (
    <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-[10px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1 text-left font-medium text-amber-200 hover:text-amber-100"
        title="A story from your bank to tell here"
      >
        <span className="shrink-0">📖 Story to tell:</span>
        <span className={open ? '' : 'truncate'}>{title}</span>
      </button>
      {open && body.length > 0 && (
        <div className="mt-1 space-y-0.5 text-amber-100/80">
          {body.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Proof-linked sources: the answer cites context chunks inline as [1], [2]…; this
 *  surfaces those as glanceable chips that expand to the cited chunk. The chunk list
 *  comes from the same contextSent payload shown in "Data sent to OpenAI". */
export function Citations({
  card,
  openKey,
  onToggle,
}: {
  card: CardModel;
  openKey: string | null;
  onToggle: (k: string | null) => void;
}) {
  const chunks = card.context?.chunks;
  if (!chunks || !card.body) return null;
  const cited = [...new Set([...card.body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
    .filter((n) => chunks[n - 1])
    .sort((a, b) => a - b);
  if (cited.length === 0) return null;
  const openN = openKey?.startsWith(`${card.id}:`) ? Number(openKey.split(':')[1]) : null;
  const openChunk = openN ? chunks[openN - 1] : null;
  return (
    <div className="mt-1.5 text-[10px]">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-neutral-500">📎 Sources:</span>
        {cited.map((n) => {
          const key = `${card.id}:${n}`;
          return (
            <button
              key={n}
              onClick={() => onToggle(openKey === key ? null : key)}
              title={`${chunks[n - 1].sourceType} · ${Math.round(chunks[n - 1].score * 100)}% match`}
              className={`rounded px-1 py-px font-medium transition-colors ${
                openKey === key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              [{n}] {chunks[n - 1].sourceType === 'story' ? '📖 story' : chunks[n - 1].sourceType}
            </button>
          );
        })}
      </div>
      {openChunk && (
        <p className="mt-1 rounded bg-neutral-950/70 p-1.5 leading-snug text-neutral-400">
          {openChunk.content.slice(0, 320)}
          {openChunk.content.length > 320 ? '…' : ''}
        </p>
      )}
    </div>
  );
}
