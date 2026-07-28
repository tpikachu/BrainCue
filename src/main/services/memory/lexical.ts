/**
 * Lexical scoring for memory recall — the half of retrieval that embeddings
 * are structurally bad at.
 *
 * Vectors blur exactly the tokens a grounded answer most needs to get right:
 * proper nouns, ticket ids, version numbers, dates, figures. "ATL-4471" and
 * "ATL-4478" embed to nearly the same point; to a human they are different
 * tickets. So recall runs both and unions the results (docs/14-MEMORY.md §3.3).
 *
 * Why not SQLite FTS5: the test harness (sql.js 1.14) ships FTS3/FTS4 but NOT
 * FTS5, so an FTS5 virtual table would fail every migration under test and
 * leave this path — which decides what an agent says out loud — unverifiable.
 * FTS4 has no BM25 ranking, which is the only reason to want FTS in the first
 * place. Scoring here in JS is testable on every engine and gives direct
 * control over the rare-token weighting below. If corpus size ever makes this
 * the bottleneck, the swap point is this module's interface, not its callers.
 */

/** Words carrying no discriminating power — dropped from both sides. */
const STOPWORDS = new Set(
  ('a an the is are was were be been being do does did doing have has had having ' +
    'what when where who whom why how which that this these those there here ' +
    'i me my mine you your yours he him his she her hers it its we us our ours ' +
    'they them their theirs of for to in on at by with and or but so if then ' +
    'about into over under again further once no not only own same too very can ' +
    'will just should now').split(' '),
);

/**
 * Tokens for matching. Alphanumerics split on everything else, EXCEPT that
 * identifier-shaped runs (ATL-4471, v2.0.1, 2026-07-23) are kept whole as well
 * as split — so "ATL-4471" matches both the exact identifier and a query that
 * only remembers "4471".
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];

  // Identifier-shaped runs: letters+digits joined by - . _ / with at least one
  // digit somewhere (that digit is what makes it an identifier and not prose).
  for (const m of lower.matchAll(/[a-z0-9]+(?:[-._/][a-z0-9]+)+/g)) {
    if (/\d/.test(m[0])) out.push(m[0]);
  }

  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    // Single letters are noise; single digits are not (a "3" can matter).
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export interface LexicalIndex {
  /** token → inverse document frequency (ranking weight). */
  idf: Map<string, number>;
  /** token → how many documents contain it (rarity, corpus-size independent). */
  df: Map<string, number>;
  total: number;
}

/**
 * Index the candidate corpus. Rare tokens — a name, a ticket id, a date —
 * carry most of the ranking weight; tokens in every memory carry almost none.
 * This is what makes an exact identifier match beat a fuzzy topical one.
 *
 * Document frequency is kept alongside IDF because the two answer different
 * questions. IDF is a *weight*, and its magnitude moves with corpus size — the
 * same token scores 0.69 among 2 memories and 2.0 among 10. Deciding "is this
 * token specific enough to pull a memory in on its own?" needs a measure that
 * does not drift as the user's memory grows, so `hasExactAnchor` asks df.
 */
export function buildIndex(documents: string[]): LexicalIndex {
  const total = documents.length || 1;
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const t of new Set(tokenize(doc))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [token, n] of df) {
    // Smoothed IDF, floored at 0 so a token present everywhere contributes
    // nothing rather than going negative.
    idf.set(token, Math.max(0, Math.log((total + 1) / (n + 0.5))));
  }
  return { idf, df, total };
}

/**
 * How well `content` answers `queryTokens`, in 0..1 — the share of the query's
 * total token WEIGHT that the content actually contains. A memory matching the
 * one rare token in a query scores far higher than one matching three common
 * ones, which is the behaviour exact recall needs.
 */
export function lexicalScore(
  queryTokens: string[],
  content: string,
  index: LexicalIndex,
): number {
  if (queryTokens.length === 0) return 0;
  const have = new Set(tokenize(content));
  // A token absent from the corpus is maximally rare: weight it as if it
  // appeared in a single document.
  const unseen = Math.log((index.total + 1) / 1.5);

  let total = 0;
  let hit = 0;
  for (const t of new Set(queryTokens)) {
    const w = index.idf.get(t) ?? unseen;
    total += w;
    if (have.has(t)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

/**
 * True when the query names something specific that the content actually
 * contains — an identifier, a number, or a distinctly rare word.
 *
 * This is the gate that lets a lexical hit surface a memory the semantic floor
 * would have discarded: asked for "ticket ATL-4471", the memory recording it
 * must come back even though its embedding sits nowhere near the question's.
 */
export function hasExactAnchor(
  queryTokens: string[],
  content: string,
  index: LexicalIndex,
): boolean {
  const have = new Set(tokenize(content));
  // Rare = in at most a quarter of the corpus, and never more than a handful
  // of memories. Both bounds matter: the fraction keeps it meaningful in a
  // large store, the absolute cap keeps it meaningful in a nearly empty one.
  const rareEnough = Math.max(1, Math.min(3, Math.floor(index.total * 0.25)));
  for (const t of new Set(queryTokens)) {
    if (!have.has(t)) continue;
    // Identifiers and figures are specific by construction; short words are
    // not, however rare they happen to be in this particular corpus.
    if (!/\d/.test(t) && t.length < 4) continue;
    if ((index.df.get(t) ?? 1) <= rareEnough) return true;
  }
  return false;
}
