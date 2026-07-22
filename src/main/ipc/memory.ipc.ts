import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { memoriesRepo } from '../db/repositories/memories.repo';
import { contextPacksRepo } from '../db/repositories/jobs.repo';
import { approveMemory, updateMemory } from '../services/memory/memoryService';

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

/** Library › Memory review surface. Every transition here is an explicit user
 *  action — extraction only ever produces `pending` rows. */
export function registerMemoryIpc(): void {
  handle(
    IPC.memory.list,
    z.object({
      profileId: z.string().min(1),
      status: z.enum(['pending', 'approved', 'rejected', 'archived']).optional(),
      query: z.string().optional(),
    }),
    ({ profileId, status, query }) => memoriesRepo.list({ profileId, status, query }),
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
