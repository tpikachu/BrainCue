import { memoriesRepo } from '../../db/repositories/memories.repo';
import { providerFor } from '../../providers/registry';
import { assertEmbeddingCompatibility } from '../rag/embeddingIdentity';
import { vectorToBuffer } from '../rag/vectorMath';
import { checkSensitive } from './sensitiveFilter';
import type { MemoryCategory, MemoryItem } from '@shared/types';

/** Review orchestration: approval (optionally with edits) embeds the content
 *  and stamps the embedding identity on the row; edits to an approved
 *  memory's content re-embed. The sensitive gate applies to EDITS too — a
 *  user paste can't sneak a secret into the store. */

async function embed(content: string) {
  const embedding = providerFor('embedding');
  const identity = embedding.identity();
  assertEmbeddingCompatibility(identity); // one embedding space per database
  const vector = await embedding.embedOne(content);
  return {
    provider: identity.provider,
    model: identity.model,
    dim: identity.dim,
    vector: vectorToBuffer(vector),
  };
}

export async function approveMemory(
  id: string,
  edits: { content?: string; category?: MemoryCategory; packId?: string | null } = {},
): Promise<MemoryItem> {
  const existing = memoriesRepo.get(id);
  if (!existing) throw new Error('Memory not found');
  const content = edits.content?.trim() || existing.content;
  const verdict = checkSensitive(content);
  if (verdict.sensitive) {
    throw new Error(`This looks like ${verdict.reason} data — BrainCue won't store it as memory.`);
  }
  return memoriesRepo.approve(id, {
    content,
    category: edits.category ?? existing.category,
    packId: edits.packId !== undefined ? edits.packId : existing.packId,
    embedding: await embed(content),
  });
}

export async function updateMemory(
  id: string,
  patch: {
    content?: string;
    category?: MemoryCategory;
    importance?: number;
    packId?: string | null;
    expiresAt?: number | null;
  },
): Promise<MemoryItem> {
  const existing = memoriesRepo.get(id);
  if (!existing) throw new Error('Memory not found');
  if (patch.content !== undefined) {
    const verdict = checkSensitive(patch.content);
    if (verdict.sensitive) {
      throw new Error(
        `This looks like ${verdict.reason} data — BrainCue won't store it as memory.`,
      );
    }
  }
  const contentChanged = patch.content !== undefined && patch.content !== existing.content;
  return memoriesRepo.update(id, {
    ...patch,
    // Approved memories must stay searchable: content edits re-embed.
    ...(contentChanged && existing.status === 'approved'
      ? { embedding: await embed(patch.content!) }
      : {}),
  });
}
