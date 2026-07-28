import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { memoriesRepo } from '../db/repositories/memories.repo';
import { contextPacksRepo } from '../db/repositories/jobs.repo';
import { approveMemory, createMemory, updateMemory } from '../services/memory/memoryService';

/** "domain:subject/attribute", lowercase kebab — mirrors the extractor's
 *  schema so hand-authored and extracted facts share one key space. */
const zFactKey = z
  .string()
  .regex(/^[a-z0-9]+:[a-z0-9-]+\/[a-z0-9-]+$/, 'Use the form domain:subject/attribute')
  .max(80);

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
    IPC.memory.create,
    z.object({
      profileId: z.string().min(1),
      packId: z.string().nullable().default(null),
      category: zCategory,
      content: z.string().min(3).max(1000),
      importance: z.number().min(0).max(1).optional(),
      factKey: zFactKey.nullable().optional(),
    }),
    (args) => createMemory(args),
  );

  handle(IPC.memory.conflicts, z.object({ profileId: z.string().min(1) }), ({ profileId }) =>
    memoriesRepo.conflicts(profileId),
  );

  handle(
    IPC.memory.history,
    z.object({ profileId: z.string().min(1), factKey: zFactKey }),
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
