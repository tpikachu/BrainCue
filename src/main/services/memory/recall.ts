import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { bufferToVector, cosineSimilarity } from '../rag/vectorMath';
import type { MemoryCategory, RetrievedMemory } from '@shared/types';

/**
 * Memory recall for grounding — hybrid (semantic + lexical), scope-aware,
 * budget-capped, and consent-gated. Ranking contract: SEMANTIC relevance is
 * the gate (a memory below the cosine floor never surfaces, whatever its
 * importance); lexical overlap, importance, and recency are small tiebreak
 * signals only. Recall failures return [] — memory must never break answers.
 */

export const MEMORY_TOP_K = 3;
export const MEMORY_MIN_SCORE = 0.25; // floor on the SEMANTIC score alone
export const MEMORY_MAX_CHARS = 300; // per-memory context budget cap

const LEXICAL_WEIGHT = 0.08;
const IMPORTANCE_WEIGHT = 0.05;
const RECENCY_WEIGHT = 0.03;
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set(
  'a an the is are was were what when where who why how which our your their my of for to in on at by with and or so we you they i it this that do does did'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** Fraction of query content words that appear in the memory. */
function lexicalOverlap(query: Set<string>, content: string): number {
  if (query.size === 0) return 0;
  const c = words(content);
  let hit = 0;
  for (const w of query) if (c.has(w)) hit += 1;
  return hit / query.size;
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
    const queryWords = words(query);
    const scored = usable
      .map((r) => {
        const semantic = cosineSimilarity(queryVector, bufferToVector(r.embedVector as Buffer));
        const recent =
          (r.lastUsedAt ?? r.updatedAt) >= now - RECENCY_WINDOW_MS ? RECENCY_WEIGHT : 0;
        return {
          row: r,
          semantic,
          blended:
            semantic +
            LEXICAL_WEIGHT * lexicalOverlap(queryWords, r.content) +
            IMPORTANCE_WEIGHT * r.importance +
            recent,
        };
      })
      .filter((s) => s.semantic >= MEMORY_MIN_SCORE) // semantic gate, not blended
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
