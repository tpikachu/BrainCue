import type { RollbackResult } from '@shared/types';

/**
 * What a failed start's rollback CONFIRMED, in words — one sentence for both
 * windows (the dashboard's notice and the Cue Card's banner), so whichever
 * Stop was pressed, the user is told the same thing. Never claims more than
 * the result: a stop that failed is "may still be running", a removal that
 * failed names the record left behind.
 */
export function rollbackMessage(r: RollbackResult): string {
  const why = r.error ? ` (${r.error.trim().replace(/\.$/, '')})` : '';
  if (!r.stopped) return `Stopping the session failed${why} — it may still be running. Press Stop to try again.`;
  if (r.removed === false) {
    return `The session was stopped, but its empty record couldn't be removed${why} — delete it from Sessions.`;
  }
  if (r.removed) return 'The session was stopped and removed — nothing was recorded.';
  return 'The session was stopped; its earlier content is kept.';
}
