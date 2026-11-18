import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { archiveSessionOutcome } from '../engine/sessionArchive';
import { extractMemoryOutcome } from '../memory/extractor';
import type { KeepStep, RememberResult } from '@shared/types';

/** A half that actually asked the parsing provider (so the result names it). */
const reachedProvider = (s: KeepStep) =>
  s.status === 'done' || s.status === 'nothing-new' || s.status === 'withheld' || s.status === 'failed';

/**
 * Keep a finished conversation (docs/16-CONTINUITY.md §9) and say exactly
 * what happened.
 *
 * The session and its transcript are ALREADY on this machine; keeping it is
 * about the two things that may follow, each gated again internally (global
 * switch, per-Space opt-out, consent): the retrievable summary and the memory
 * suggestions. Each reports its own outcome — done, declined and why, or
 * failed and why — so the save prompt never infers a reason from a zero count,
 * and a failure can be retried (re-archiving replaces; re-extraction skips
 * what is already known).
 *
 * The destination is validated here, wherever the picker found it: a Space
 * that was deleted, or that belongs to another profile, is refused before
 * anything is filed — the session is never filed into it.
 *
 * @param packId a string files the session into that Space, `null` files it
 *   out of every Space, `undefined` leaves it where it ran.
 * @param parsingProvider which provider the summary/suggestions go to (the
 *   parsing task's route), named in the result when either half reached it.
 */
export async function rememberSession(
  id: string,
  packId: string | null | undefined,
  parsingProvider: () => string | null,
): Promise<RememberResult> {
  const session = sessionsRepo.get(id);
  if (!session) throw new Error('Session not found');
  if (typeof packId === 'string') {
    const pack = contextPacksRepo.get(packId);
    if (!pack) throw new Error('That Space no longer exists — choose another, or keep it without one.');
    if (pack.profileId !== session.profileId) throw new Error('That Space belongs to another profile — choose one of this profile’s.');
  }
  // Filing FIRST is what makes the choice mean anything: both the archive and
  // the memory suggestions read their scope off this column.
  if (packId !== undefined) sessionsRepo.setPack(id, packId);
  const filed = packId !== undefined ? packId : session.jobId;
  const [summary, memory] = await Promise.all([archiveSessionOutcome(id), extractMemoryOutcome(id)]);
  return {
    kept: true,
    packId: filed ?? null,
    summary,
    memory,
    provider: reachedProvider(summary) || reachedProvider(memory) ? parsingProvider() : null,
    archived: summary.count,
    memories: memory.count,
  };
}
