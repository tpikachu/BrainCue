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

/** Which side of an interview a chunk speaks for. */
type SourceGroup = 'candidate' | 'role' | 'archive';
export function sourceGroup(s: ChunkSource): SourceGroup {
  if (s === 'jd' || s === 'company') return 'role';
  if (s === 'session') return 'archive';
  return 'candidate'; // resume, tailored, note, story, profile
}

/** A swapped-in chunk must still be relevant: at least this share of the
 *  best match's score (and, for cosine scores, an absolute floor). */
export const BALANCE_RELATIVE_FLOOR = 0.6;
export const BALANCE_COSINE_FLOOR = 0.2;

/**
 * Keep one source from crowding out the other.
 *
 * Pure cosine ranking routinely handed all five slots to résumé chunks (a
 * long CV has many near-duplicates of "I led…") or all five to the JD (whose
 * wording mirrors the interviewer's), so an answer was either grounded in
 * the candidate's history with no idea what the role needs, or the reverse.
 * When the top-k has no chunk from the candidate's side or from the role's
 * side, the best RELEVANT chunk of the missing side replaces the weakest
 * chunk of the over-represented side. Irrelevant chunks are never forced in:
 * a swap needs a score within BALANCE_RELATIVE_FLOOR of the best match.
 */
export function balanceSources(
  picked: RetrievedChunk[],
  ranked: RetrievedChunk[],
  opts: { cosine?: boolean } = {},
): RetrievedChunk[] {
  if (picked.length < 2) return picked;
  const top = Math.max(...picked.map((c) => c.score));
  const floor = Math.max(top * BALANCE_RELATIVE_FLOOR, opts.cosine === false ? 0 : BALANCE_COSINE_FLOOR);
  const out = [...picked];
  for (const need of ['role', 'candidate'] as const) {
    if (out.some((c) => sourceGroup(c.sourceType) === need)) continue;
    const cand = ranked.find((c) => sourceGroup(c.sourceType) === need && c.score >= floor && !out.some((o) => o.id === c.id));
    if (!cand) continue;
    // Replace the weakest chunk of the group that holds the most slots.
    const counts = new Map<SourceGroup, number>();
    for (const c of out) counts.set(sourceGroup(c.sourceType), (counts.get(sourceGroup(c.sourceType)) ?? 0) + 1);
    const heavy = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!heavy || (counts.get(heavy) ?? 0) < 2) continue;
    let weakest = -1;
    out.forEach((c, i) => {
      if (sourceGroup(c.sourceType) === heavy && (weakest < 0 || c.score < out[weakest].score)) weakest = i;
    });
    if (weakest >= 0) out[weakest] = cand;
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Embed the query and return the top-k chunks for grounding: the profile's
 *  resume/notes plus, when given, the selected pack's JD — and up to
 *  SESSION_ARCHIVE_MAX archives of earlier conversations.
 *
 *  With `storyCue` (interview-family modes only — see engine/grounding.ts), a
 *  strongly-matching STAR `story` is force-included even if it didn't make the
 *  top-k, so it grounds the answer AND surfaces as the Cue Card's "Story to
 *  tell". The query is embedded ONCE and reused for the story lookup. */
export async function retrieve(
  profileId: string,
  query: string,
  k = 5,
  jobId: string | null = null,
  opts: { storyCue?: boolean; tailoredResume?: boolean } = {},
): Promise<RetrievedChunk[]> {
  // Nothing indexed for this profile → nothing to rank. Skipping the embedding
  // call here took 1.5 s off the first token for a Space without documents.
  if (!sqliteVectorStore.hasAny(profileId)) return [];
  const vector = await providerFor('embedding').embedOne(query);
  // Over-fetch so capping archives promotes real alternatives rather than
  // simply returning fewer chunks.
  //
  // `tailoredResume` is opt-IN (`=== true`), unlike `storyCue` below, because
  // letting a tailored résumé stand in for the real one changes what the model
  // is told the user's experience IS. Defaulting that on for a caller who did
  // not ask is how a job application ended up grounding a client meeting.
  const ranked = sqliteVectorStore.search({
    profileId,
    query: vector,
    k: k * 4,
    jobId,
    allowTailored: opts.tailoredResume === true,
  });
  const chunks = balanceSources(capSource(ranked, 'session', SESSION_ARCHIVE_MAX, k), ranked);
  if (opts.storyCue === false) return chunks;
  const story = sqliteVectorStore.topStory({ profileId, query: vector });
  if (story && story.score >= STORY_CUE_MIN_SCORE && !chunks.some((c) => c.id === story.id)) {
    chunks.push(story);
  }
  return chunks;
}
