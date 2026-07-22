import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { contributionsRepo } from '../db/repositories/contributions.repo';

/** Review surface for persisted contributions: meeting reports' action items
 *  and open questions stay editable after the session (Prompt 7); the fuller
 *  review lifecycle (accept/dismiss flows) grows with Memory (Prompt 8). */
export function registerContributionsIpc(): void {
  handle(
    IPC.contributions.update,
    z.object({
      id: z.string().min(1),
      title: z.string().nullable().optional(),
      body: z.string().optional(),
      meta: z.record(z.unknown()).nullable().optional(),
      status: z
        .enum(['planned', 'streaming', 'completed', 'dismissed', 'accepted', 'corrected', 'failed'])
        .optional(),
    }),
    ({ id, ...patch }) => contributionsRepo.update(id, patch),
  );
}
