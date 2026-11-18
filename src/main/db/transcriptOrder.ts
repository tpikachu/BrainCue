import { asc, sql } from 'drizzle-orm';
import * as schema from './schema';

/**
 * The ONE order transcript rows are read in: when each turn was SPOKEN
 * (`created_at`, written from the engine's spoken time in ms), then insertion
 * order for ties. Before M4 `created_at` was the insert time at one-second
 * resolution (`unixepoch() * 1000`): turns in the same second came back in
 * no defined order, and the candidate's turns — committed ~1.5 s late by the
 * echo guard — sorted after the interviewer's next question, so a resumed
 * session (and the coaching report) attached the reply to the wrong question.
 * Older rows keep their insert-time stamps; the rowid tie-break keeps them in
 * the order they were written.
 */
export const transcriptOrder = () => [asc(schema.transcriptChunks.createdAt), asc(sql`rowid`)] as const;
