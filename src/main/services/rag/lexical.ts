/**
 * Small, dependency-free BM25 — lexical relevance for two jobs that must not
 * wait on (or require) an embeddings call:
 *
 *  - recalling OLDER turns of the live interview for the current question
 *    (engine/interview/conversationContext.ts), on the answer's hot path;
 *  - the retrieval fallback when no embedding provider is configured
 *    (rag/retriever.ts) — weaker than vectors on paraphrase, far better than
 *    sending no grounding at all.
 *
 * Bounded by construction: callers pass at most a few thousand short docs.
 */

const STOP = new Set(
  (
    'a an and are as at be but by for from has have he her his i if in into is it its me my of on or our ' +
    'she so that the their them then there these they this to us was we were what when where which who why ' +
    'will with you your yours about can could would should did do does done just also very really been being ' +
    'how tell me walk through talk explain describe more some any than too had am'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Light suffix folding so "migrating" meets "migration" and "teams" meets
 *  "team". Deliberately crude — it only has to be consistent. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ion')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Rank `docs` against `query` with BM25 (k1 1.2, b 0.75). Returns only
 *  docs sharing at least one term, best first, at most `limit`. */
export function bm25<T>(query: string, docs: T[], text: (d: T) => string, limit = 10): Scored<T>[] {
  const q = Array.from(new Set(tokenize(query)));
  if (q.length === 0 || docs.length === 0) return [];
  const toks = docs.map((d) => tokenize(text(d)));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const out: Scored<T>[] = [];
  toks.forEach((t, i) => {
    if (t.length === 0) return;
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * t.length) / avg)));
    }
    if (score > 0) out.push({ item: docs[i], score });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
