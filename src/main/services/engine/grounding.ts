import { retrieve } from '../rag/retriever';
import type { RetrievedChunk, SessionMode } from '@shared/types';

/** Default grounding scope: top-k chunks over the profile corpus plus the
 *  session's context pack (JD/company/tailored for interview packs). */
export const GROUNDING_TOP_K = 5;

/**
 * Modes where a STAR story is a useful thing to force into grounding.
 *
 * `retrieve()` force-includes the best-matching `story` chunk even when it
 * misses the top-k, so it can surface as the Cue Card's "Story to tell". That
 * is a behavioural-interview device: a résumé anecdote is the right answer to
 * "tell me about a time you…" and the wrong thing to inject into a client call,
 * where it would push out an actual document and invite the model to start
 * telling the room about the user's past achievements.
 */
const STORY_CUE_MODES: SessionMode[] = ['interview', 'practice', 'interviewer_assist'];

/**
 * `mode` is REQUIRED — deliberately, and it used to default to `'interview'`.
 *
 * That default was fail-open in the worst way: `'interview'` is the one value
 * that turns interview-only retrieval ON, so a caller who forgot the argument
 * silently opted INTO it. `voiceService` did exactly that, which meant every
 * voice quick ask force-injected a résumé anecdote into a generic answer. A
 * missing argument must never be the permissive case, so there is no default
 * to forget any more.
 */
export async function ground(
  profileId: string,
  query: string,
  packId: string | null,
  mode: SessionMode,
): Promise<RetrievedChunk[]> {
  // Both are interview-family devices, and both are wrong outside it. A STAR
  // story answers "tell me about a time you…"; a TAILORED résumé is the user's
  // CV rewritten for one specific application, so letting it stand in for the
  // real one is only ever right while grounding that application's interview.
  const interviewFamily = STORY_CUE_MODES.includes(mode);
  return retrieve(profileId, query, GROUNDING_TOP_K, packId, {
    storyCue: interviewFamily,
    tailoredResume: interviewFamily,
  });
}
