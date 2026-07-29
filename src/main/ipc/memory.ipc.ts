import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { memoriesRepo } from '../db/repositories/memories.repo';
import { contextPacksRepo } from '../db/repositories/jobs.repo';
import { approveMemory, createMemory, updateMemory } from '../services/memory/memoryService';

const zCategory = z.enum([
  'preference',
  'person',
  'project',
  'goal',
  'decision',
  'fact',
  'workflow',
  'custom',
]);

/** The Memory section — a review-first surface. Every transition here is an explicit user
 *  action — extraction only ever produces `pending` rows. */
export function registerMemoryIpc(): void {
  handle(
    IPC.memory.list,
    z.object({
      profileId: z.string().min(1),
      status: z.enum(['pending', 'approved', 'rejected', 'archived']).optional(),
      query: z.string().optional(),
      // Filter to ONE Space (or, with null, to what is remembered everywhere).
      // Absent means every scope — the memory page's default view.
      packId: z.string().min(1).nullable().optional(),
    }),
    ({ profileId, status, query, packId }) =>
      memoriesRepo.list({ profileId, status, query, packId }),
  );

  /**
   * Author a memory directly — "here is what you should know about me".
   *
   * Created pending, then approved in the same call so it is one action for
   * the user. If embedding fails (no key, no network) the approval throws and
   * the memory is left waiting in review, which is the honest outcome: it
   * exists, it is simply not searchable yet.
   */
  handle(
    IPC.memory.create,
    z.object({
      profileId: z.string().min(1),
      content: z.string().min(3).max(1000),
      category: zCategory.default('fact'),
      packId: z.string().min(1).nullable().default(null),
      importance: z.number().min(0).max(1).optional(),
    }),
    async ({ profileId, content, category, packId, importance }) => {
      const created = createMemory({ profileId, packId, category, content, importance });
      return approveMemory(created.id);
    },
  );

  /** Pending candidates that would REPLACE a current fact, paired with what
   *  they'd replace. Review shows both; nothing is superseded automatically. */
  handle(IPC.memory.conflicts, z.object({ profileId: z.string().min(1) }), ({ profileId }) =>
    memoriesRepo.conflicts(profileId),
  );

  /** What a fact says now and what it used to say. Never feeds recall. */
  handle(
    IPC.memory.history,
    z.object({ profileId: z.string().min(1), factKey: z.string().min(1).max(80) }),
    ({ profileId, factKey }) => memoriesRepo.history(profileId, factKey),
  );

  handle(
    IPC.memory.review,
    z.object({
      id: z.string().min(1),
      action: z.enum(['approve', 'reject']),
      // Approve-with-edits: the reviewed text is what gets stored + embedded.
      content: z.string().min(1).max(1000).optional(),
      category: zCategory.optional(),
      packId: z.string().nullable().optional(),
    }),
    async ({ id, action, content, category, packId }) => {
      if (action === 'reject') return memoriesRepo.setStatus(id, 'rejected');
      return approveMemory(id, { content, category, packId });
    },
  );

  handle(
    IPC.memory.update,
    z.object({
      id: z.string().min(1),
      content: z.string().min(1).max(1000).optional(),
      category: zCategory.optional(),
      importance: z.number().min(0).max(1).optional(),
      packId: z.string().nullable().optional(),
      expiresAt: z.number().nullable().optional(),
    }),
    ({ id, ...patch }) => updateMemory(id, patch),
  );

  handle(IPC.memory.archive, z.object({ id: z.string().min(1) }), ({ id }) =>
    memoriesRepo.setStatus(id, 'archived'),
  );

  handle(IPC.memory.delete, z.object({ id: z.string().min(1) }), ({ id }) => {
    memoriesRepo.delete(id); // row + embedding go together
    return { deleted: true as const };
  });

  handle(
    IPC.memory.setPackEnabled,
    z.object({ packId: z.string().min(1), enabled: z.boolean() }),
    ({ packId, enabled }) => {
      contextPacksRepo.setMemoryEnabled(packId, enabled);
      return { packId, enabled };
    },
  );
}
