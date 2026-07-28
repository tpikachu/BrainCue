import { z } from 'zod';
import { dialog } from 'electron';
import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { memoriesRepo } from '../db/repositories/memories.repo';
import { contextPacksRepo } from '../db/repositories/jobs.repo';
import { entitiesRepo } from '../db/repositories/entities.repo';
import { getMainWindow } from '../windows/mainWindow';
import { extractText } from '../services/documents/extract';
import { buildMemoryExport, importMemories } from '../services/memory/portability';
import { ingestDocument } from '../services/memory/ingest';
import {
  approveMemory,
  createMemory,
  mergeMemories,
  reviewMany,
  splitMemory,
  updateMemory,
} from '../services/memory/memoryService';

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

  // ── Portability (docs/14-MEMORY.md §7) ─────────────────────────────────
  // The file never leaves the machine on its own: the user picks the path,
  // and where it goes afterwards is their decision. Nothing is uploaded.
  handle(
    IPC.memory.export,
    z.object({ profileId: z.string().min(1) }),
    async ({ profileId }) => {
      const payload = buildMemoryExport(profileId);
      const stamp = new Date(payload.exportedAt).toISOString().slice(0, 10);
      const safeName = `${(payload.profile?.name ?? 'memory').replace(/[\\/:*?"<>|]/g, '-')} memory ${stamp}.json`;
      const win = getMainWindow();
      const options = {
        defaultPath: safeName,
        filters: [{ name: 'BrainCue memory', extensions: ['json'] }],
      };
      const res = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { saved: false as const, count: 0 };
      await writeFile(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { saved: true as const, count: payload.memories.length, filePath: res.filePath };
    },
  );

  handle(
    IPC.memory.import,
    z.object({
      profileId: z.string().min(1),
      // 'restore' preserves exported statuses (your own backup); 'review'
      // makes everything pending. The sensitive filter runs in both.
      mode: z.enum(['review', 'restore']).default('review'),
      filePath: z.string().min(1).optional(),
    }),
    async ({ profileId, mode, filePath }) => {
      let path = filePath;
      if (!path) {
        const win = getMainWindow();
        const options = {
          properties: ['openFile' as const],
          filters: [{ name: 'BrainCue memory', extensions: ['json'] }],
        };
        const res = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        if (res.canceled || !res.filePaths[0]) return { cancelled: true as const };
        path = res.filePaths[0];
      }
      const raw = await readFile(path, 'utf8');
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      // `cancelled` is the flag; `imported` inside the summary is a COUNT —
      // keeping them distinct so neither can shadow the other.
      return { cancelled: false as const, ...(await importMemories(profileId, payload, mode)) };
    },
  );

  // ── Authoring (docs/14-MEMORY.md §3.5) ─────────────────────────────────
  // The user is the editor of their own memory: hand it a document, approve a
  // batch, fold duplicates together, break a bundled sentence apart. Every one
  // of these still goes through the sensitive filter and the review lifecycle.
  handle(
    IPC.memory.ingest,
    z
      .object({
        profileId: z.string().min(1),
        packId: z.string().nullable().default(null),
        // Either paste the text or point at a file — the file is read and
        // parsed locally, and only the extracted text goes to the model.
        text: z.string().optional(),
        filePath: z.string().optional(),
      })
      .refine((v) => !!v.text?.trim() || !!v.filePath, {
        message: 'Provide text to import or a file to read.',
      }),
    async ({ profileId, packId, text, filePath }) => {
      let body = text ?? '';
      let label = 'Pasted text';
      if (filePath) {
        const extracted = await extractText(filePath);
        body = extracted.text;
        label = basename(filePath);
      }
      return ingestDocument({ profileId, packId, text: body, label });
    },
  );

  handle(
    IPC.memory.reviewMany,
    z.object({
      ids: z.array(z.string().min(1)).min(1).max(200),
      action: z.enum(['approve', 'reject']),
    }),
    ({ ids, action }) => reviewMany(ids, action),
  );

  handle(
    IPC.memory.merge,
    z.object({
      ids: z.array(z.string().min(1)).min(2).max(20),
      content: z.string().min(3).max(1000),
      category: zCategory.optional(),
      packId: z.string().nullable().optional(),
      factKey: zFactKey.nullable().optional(),
    }),
    (args) => mergeMemories(args),
  );

  handle(
    IPC.memory.split,
    z.object({
      id: z.string().min(1),
      parts: z.array(z.string().min(3).max(1000)).min(2).max(10),
    }),
    ({ id, parts }) => splitMemory({ id, parts }),
  );

  // ── Entities (docs/14-MEMORY.md §3.2) ──────────────────────────────────
  handle(IPC.memory.entities, z.object({ profileId: z.string().min(1) }), ({ profileId }) =>
    entitiesRepo.list(profileId),
  );

  handle(
    IPC.memory.entity,
    z.object({ profileId: z.string().min(1), entityId: z.string().min(1) }),
    ({ profileId, entityId }) => {
      const entity = entitiesRepo.resolve(entityId);
      if (!entity) throw new Error('Entity not found');
      const memories = entitiesRepo.memoriesFor(
        entity.id,
        memoriesRepo.list({ profileId, status: 'approved' }),
      );
      return { entity, memories };
    },
  );

  handle(
    IPC.memory.entityUpdate,
    z.object({
      entityId: z.string().min(1),
      canonicalName: z.string().min(1).max(120).optional(),
      kind: z.enum(['person', 'org', 'project', 'product', 'place', 'topic']).optional(),
      summary: z.string().max(2000).nullable().optional(),
      importance: z.number().min(0).max(1).optional(),
    }),
    ({ entityId, ...patch }) => entitiesRepo.update(entityId, patch),
  );

  // Merging is deliberately a USER action: automatic merging of similar names
  // corrupts memory invisibly and cannot be undone from the merged rows.
  handle(
    IPC.memory.entityMerge,
    z.object({ loserId: z.string().min(1), winnerId: z.string().min(1) }),
    ({ loserId, winnerId }) => entitiesRepo.merge(loserId, winnerId),
  );

  handle(
    IPC.memory.setPackEnabled,
    z.object({ packId: z.string().min(1), enabled: z.boolean() }),
    ({ packId, enabled }) => {
      contextPacksRepo.setMemoryEnabled(packId, enabled);
      return { packId, enabled };
    },
  );
}
