import { providerFor } from '../../providers/registry';
import { sqliteVectorStore } from './vectorStore';
import { STORY_CUE_MIN_SCORE, type ChunkSource, type RetrievedChunk } from '@shared/types';

/**
 * How many of the top-k grounding slots conversation archives may take
 * (docs/16-CONTINUITY.md).
 *
 * Without a cap this degrades badly over time, and invisibly: a user with two
 * hundred archived calls has far more `session` chunks than résumé, notes, and
 * JD chunks combined, so pure cosine ranking hands the context window to
 * conversation history and the documents that ground factual answers stop
 * appearing at all. Recent talk crowding out source material is precisely the
 * failure a companion must not have — it would sound steadily more confident
 * and steadily less tethered.
 *
 * Two of five leaves room for continuity ("we agreed X last week") while
 * keeping the majority of grounding on the corpus.
 */
export const SESSION_ARCHIVE_MAX = 2;

/** Take the top `k`, allowing at most `max` from `source`. Order is preserved,
 *  so the best match within each group still wins; the freed slots go to the
 *  next-best chunks from any other source. */
export function capSource(
  chunks: RetrievedChunk[],
  source: ChunkSource,
  max: number,
  k: number,
): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (out.length >= k) break;
    if (c.sourceType === source) {
      if (used >= max) continue;
      used += 1;
    }
    out.push(c);
  }
  return out;
}

/** Embed the query and return the top-k chunks for grounding: the profile's
 *  resume/notes plus, when given, the selected job's JD — and up to
 *  SESSION_ARCHIVE_MAX archives of earlier conversations.
 *
 *  Additionally, a strongly-matching STAR `story` is force-included (even if it
 *  didn't make the top-k) so it grounds the answer AND surfaces as the Cue Card's
 *  "Story to tell" cue. The query is embedded ONCE and reused for the story lookup. */
export async function retrieve(
  profileId: string,
  query: string,
  k = 5,
  jobId: string | null = null,
): Promise<RetrievedChunk[]> {
  const vector = await providerFor('embedding').embedOne(query);
  // Over-fetch so capping archives promotes real alternatives rather than
  // simply returning fewer chunks.
  const ranked = sqliteVectorStore.search({ profileId, query: vector, k: k * 4, jobId });
  const chunks = capSource(ranked, 'session', SESSION_ARCHIVE_MAX, k);
  const story = sqliteVectorStore.topStory({ profileId, query: vector });
  if (story && story.score >= STORY_CUE_MIN_SCORE && !chunks.some((c) => c.id === story.id)) {
    chunks.push(story);
  }
  return chunks;
}
