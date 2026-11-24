import { providerFor } from '../../providers/registry';

/**
 * The query embedding on the LIVE answer path (grounding and memory recall),
 * bounded and shared. M7.2b / PERF-01.
 *
 * Bounded: the embedding client retries twice with a 60 s timeout per try —
 * right for indexing a résumé, wrong while someone waits for a cue. Past
 * LIVE_EMBED_DEADLINE_MS the request is aborted and the caller ranks the SAME
 * documents and memories lexically instead: the knowledge base is never
 * dropped, only the semantic half of its ranking for that one question. The
 * deadline caps the tail; it is well above a normal round trip, so the
 * normal path is unchanged.
 *
 * Shared: retrieval and recall used to embed the question one after the
 * other — two round trips for the same text. Concurrent and recent requests
 * for the same text (same embedding space) now share one call. The cache is
 * a handful of entries for a few seconds, in memory only.
 */

export const LIVE_EMBED_DEADLINE_MS = 2500;
const SHARE_MS = 15_000;
const SHARE_MAX = 8;

const shared = new Map<string, { at: number; vector: Promise<Float32Array> }>();

export class EmbedDeadlineError extends Error {
  constructor() {
    super('The live embedding exceeded its deadline.');
  }
}

export function embedLiveQuery(text: string, deadlineMs = LIVE_EMBED_DEADLINE_MS, now = Date.now()): Promise<Float32Array> {
  const embedder = providerFor('embedding');
  const id = embedder.identity();
  const key = `${id.provider}\u0000${id.model}\u0000${id.dim}\u0000${text}`;
  for (const [k, v] of shared) if (now - v.at > SHARE_MS) shared.delete(k);
  const hit = shared.get(key);
  if (hit) return hit.vector;

  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vector = Promise.race([
    embedder.embedOne(text, { signal: ctl.signal }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new EmbedDeadlineError()); // settles the race first …
        ctl.abort(); // … then releases the request
      }, deadlineMs);
    }),
  ]).finally(() => timer && clearTimeout(timer));
  // A failed or late embedding is not reused: the next question tries again.
  vector.catch(() => shared.delete(key));
  shared.set(key, { at: now, vector });
  while (shared.size > SHARE_MAX) shared.delete(shared.keys().next().value!);
  return vector;
}

/** Tests only. */
export function clearLiveEmbedCache(): void {
  shared.clear();
}
