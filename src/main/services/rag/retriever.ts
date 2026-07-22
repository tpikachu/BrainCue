import { providerFor } from '../../providers/registry';
import { sqliteVectorStore } from './vectorStore';
import { STORY_CUE_MIN_SCORE, type RetrievedChunk } from '@shared/types';

/** Embed the query and return the top-k chunks for grounding: the profile's
 *  resume/notes plus, when given, the selected job's JD.
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
  const chunks = sqliteVectorStore.search({ profileId, query: vector, k, jobId });
  const story = sqliteVectorStore.topStory({ profileId, query: vector });
  if (story && story.score >= STORY_CUE_MIN_SCORE && !chunks.some((c) => c.id === story.id)) {
    chunks.push(story);
  }
  return chunks;
}
