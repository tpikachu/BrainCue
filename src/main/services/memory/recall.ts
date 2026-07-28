import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { bufferToVector, cosineSimilarity } from '../rag/vectorMath';
import { buildIndex, hasExactAnchor, lexicalScore, tokenize } from './lexical';
import { entitiesRepo, matchKey } from '../../db/repositories/entities.repo';
import type { Entity, MemoryCategory, RetrievedMemory } from '@shared/types';

/**
 * Memory recall for grounding — hybrid (semantic ∪ lexical), scope-aware,
 * budget-capped, and consent-gated. Recall failures return [] — memory must
 * never break answers.
 *
 * SURFACING CONTRACT (changed in M2, docs/14-MEMORY.md §3.3). Previously the
 * semantic score was the sole gate, which meant a memory could never be
 * recalled by naming the thing it is about: embeddings blur identifiers, so
 * "ticket ATL-4471" sits nowhere near the memory recording ATL-4471 and the
 * cosine floor discarded it. A memory now surfaces when EITHER
 *
 *   • its semantic score clears MEMORY_MIN_SCORE (topical match, as before), OR
 *   • the query names something specific that it actually contains — an
 *     identifier, figure, or distinctly rare word (see hasExactAnchor)
 *
 * and is then ranked by a blend of both signals. Importance and recency remain
 * small tiebreaks, never gates: a memory nothing asked for must not surface
 * because it happens to be important.
 */

export const MEMORY_TOP_K = 3;
export const MEMORY_MIN_SCORE = 0.25; // floor on the SEMANTIC score alone
export const MEMORY_MAX_CHARS = 300; // per-memory context budget cap
/** A lexical hit needs this much of the query's token weight before it can
 *  surface a memory on its own — one shared rare word is not a match. */
export const MEMORY_MIN_LEXICAL = 0.34;

const LEXICAL_WEIGHT = 0.45; // a real ranking signal now, not a tiebreak
const IMPORTANCE_WEIGHT = 0.05;
const RECENCY_WEIGHT = 0.03;
const ENTITY_WEIGHT = 0.2; // naming the subject is strong evidence of relevance
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Entities the query names, by longest match first so "Sarah Chen" wins over a
 * separate "Sarah". Matching is exact on canonical name or alias — the same
 * conservative rule the store uses everywhere, so recall can never invent a
 * connection the user has not accepted.
 */
function entitiesInQuery(profileId: string, query: string): Entity[] {
  const haystack = ` ${matchKey(query)} `;
  const hits = entitiesRepo
    .list(profileId)
    .filter((e) =>
      [matchKey(e.canonicalName), ...e.aliases].some(
        (name) => name.length >= 3 && haystack.includes(` ${name} `),
      ),
    );
  return hits.sort((a, b) => b.canonicalName.length - a.canonicalName.length).slice(0, 4);
}

export async function recallMemories(
  profileId: string,
  query: string,
  packId: string | null,
  now = Date.now(),
): Promise<RetrievedMemory[]> {
  try {
    if (settingsRepo.get(SETTINGS_KEYS.memoryEnabled) !== '1') return []; // consent off
    if (packId) {
      const pack = contextPacksRepo.get(packId);
      if (pack && !pack.memoryEnabled) return []; // Space opted out
    }
    const rows = memoriesRepo.recallRows(profileId, packId, now);
    if (rows.length === 0) return [];

    // Only vectors from the CURRENT embedding space are comparable; rows from
    // an older provider/model wait for a re-embed rather than mis-ranking.
    const identity = providerFor('embedding').identity();
    const usable = rows.filter(
      (r) =>
        r.embedProvider === identity.provider &&
        r.embedModel === identity.model &&
        r.embedDim === identity.dim,
    );
    if (usable.length === 0) return [];

    const queryVector = await providerFor('embedding').embedOne(query);
    const queryTokens = tokenize(query);
    // Indexed over THIS profile's memories: rarity is relative to what the user
    // actually stores, so a word common in their corpus stops being a signal.
    const index = buildIndex(usable.map((r) => r.content));

    // Structured path (§3.2): if the query names an entity we know, every
    // current memory about it is a candidate — including ones phrased so
    // differently that neither cosine nor token overlap would find them.
    const named = entitiesInQuery(profileId, query);
    const aboutNamed = named.length
      ? entitiesRepo.currentMemoryIds(
          named.map((e) => e.id),
          now,
        )
      : new Set<string>();

    const scored = usable
      .map((r) => {
        const semantic = cosineSimilarity(queryVector, bufferToVector(r.embedVector as Buffer));
        const lexical = lexicalScore(queryTokens, r.content, index);
        const recent =
          (r.lastUsedAt ?? r.updatedAt) >= now - RECENCY_WINDOW_MS ? RECENCY_WEIGHT : 0;
        const aboutEntity = aboutNamed.has(r.id);
        return {
          row: r,
          semantic,
          lexical,
          aboutEntity,
          // Both signals contribute, with lexical weighted heavily enough that
          // an exact identifier match outranks a merely topical neighbour.
          blended:
            semantic +
            LEXICAL_WEIGHT * lexical +
            IMPORTANCE_WEIGHT * r.importance +
            (aboutEntity ? ENTITY_WEIGHT : 0) +
            recent,
        };
      })
      .filter(
        (s) =>
          s.semantic >= MEMORY_MIN_SCORE ||
          s.aboutEntity ||
          (s.lexical >= MEMORY_MIN_LEXICAL &&
            hasExactAnchor(queryTokens, s.row.content, index)),
      )
      .sort((a, b) => b.blended - a.blended)
      .slice(0, MEMORY_TOP_K);

    memoriesRepo.markUsed(
      scored.map((s) => s.row.id),
      now,
    );
    return scored.map((s) => ({
      id: s.row.id,
      category: s.row.category as MemoryCategory,
      content:
        s.row.content.length > MEMORY_MAX_CHARS
          ? `${s.row.content.slice(0, MEMORY_MAX_CHARS - 1)}…`
          : s.row.content,
      score: s.semantic,
    }));
  } catch {
    return []; // recall must never break an answer
  }
}
