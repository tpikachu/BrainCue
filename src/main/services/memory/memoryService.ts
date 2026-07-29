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

/**
 * Approve a candidate — and, when it carries a factKey that already has a
 * current value, RETIRE that value in the same step.
 *
 * This is the truthfulness guarantee (docs/14-MEMORY.md §4): after approval
 * there is exactly one current row per fact, so an answer grounded in memory
 * cannot state last month's version. The old row is stamped, not deleted — the
 * history chain stays readable.
 */
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
  const packId = edits.packId !== undefined ? edits.packId : existing.packId;

  // Embed BEFORE any write: a provider failure must leave the store untouched
  // rather than half-superseded.
  const embedding = await embed(content);

  // Resolved against the SCOPE being approved into, so moving a candidate to a
  // Space retires that Space's value — not the profile-wide one it no longer
  // belongs to.
  const superseded = existing.factKey
    ? memoriesRepo.currentByFactKey(existing.profileId, packId, existing.factKey)
    : null;

  const approved = memoriesRepo.approve(id, {
    content,
    category: edits.category ?? existing.category,
    packId,
    embedding,
  });

  if (superseded && superseded.id !== id) {
    memoriesRepo.supersede(superseded.id, id);
    memoriesRepo.setRevision(id, superseded.revision + 1);
    return memoriesRepo.get(id)!;
  }
  return approved;
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
