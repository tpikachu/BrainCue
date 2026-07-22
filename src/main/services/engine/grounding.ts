import { retrieve } from '../rag/retriever';
import type { RetrievedChunk } from '@shared/types';

/** Default grounding scope: top-k chunks over the profile corpus plus the
 *  session's context pack (JD/company/tailored for interview packs). */
export const GROUNDING_TOP_K = 5;

export async function ground(
  profileId: string,
  query: string,
  packId: string | null,
): Promise<RetrievedChunk[]> {
  return retrieve(profileId, query, GROUNDING_TOP_K, packId);
}
