import { memoriesRepo } from '../../db/repositories/memories.repo';
import { entitiesRepo } from '../../db/repositories/entities.repo';
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
 * This is the truthfulness guarantee (docs/14-MEMORY.md §3.1): after approval
 * there is exactly one current row per fact, so an agent grounded in memory
 * cannot state last month's answer. The old row is stamped, not deleted — the
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
    memoriesRepo.setRevision(id, memoriesRepo.nextRevision(superseded));
    return memoriesRepo.get(id)!;
  }
  return approved;
}

/**
 * Create a memory the user typed themselves. It still lands `pending` and
 * still passes the sensitive gate — authoring is a faster path to the same
 * review lifecycle, never a bypass of it (docs/14-MEMORY.md §4).
 */
export function createMemory(opts: {
  profileId: string;
  packId: string | null;
  category: MemoryCategory;
  content: string;
  importance?: number;
  factKey?: string | null;
}): MemoryItem {
  const content = opts.content.trim();
  if (content.length < 3) throw new Error('A memory needs some content.');
  const verdict = checkSensitive(content);
  if (verdict.sensitive) {
    throw new Error(`This looks like ${verdict.reason} data — BrainCue won't store it as memory.`);
  }
  const id = memoriesRepo.insertCandidate({
    profileId: opts.profileId,
    packId: opts.packId,
    category: opts.category,
    content,
    // The user asserting something directly is the strongest signal there is.
    confidence: 1,
    importance: opts.importance ?? 0.6,
    sourceRefs: [],
    factKey: opts.factKey ?? null,
    sourceKind: 'authored',
  });
  return memoriesRepo.get(id)!;
}

/**
 * Approve or reject many candidates in one action.
 *
 * Each one is attempted independently and failures are RETURNED, not thrown:
 * approving embeds, so one provider hiccup or one candidate the sensitive
 * filter rejects must not silently abandon the other nineteen. The caller
 * reports the failures; nothing is reported as done that isn't.
 */
export async function reviewMany(
  ids: string[],
  action: 'approve' | 'reject',
): Promise<{ approved: string[]; rejected: string[]; failed: { id: string; error: string }[] }> {
  const out = {
    approved: [] as string[],
    rejected: [] as string[],
    failed: [] as { id: string; error: string }[],
  };
  for (const id of ids) {
    try {
      if (action === 'reject') {
        memoriesRepo.setStatus(id, 'rejected');
        out.rejected.push(id);
      } else {
        await approveMemory(id);
        out.approved.push(id);
      }
    } catch (e) {
      out.failed.push({ id, error: (e as Error).message });
    }
  }
  return out;
}

/** Approve freshly created rows, deleting every one of them if any fails, so a
 *  merge or split either happens or leaves no trace. Half a split is a mess the
 *  user has to clean up by hand. */
async function approveAllOrRollback(ids: string[]): Promise<void> {
  try {
    for (const id of ids) await approveMemory(id);
  } catch (e) {
    for (const id of ids) memoriesRepo.delete(id);
    throw e;
  }
}

/**
 * Fold several memories into one the user has written (docs/14-MEMORY.md §3.5).
 *
 * The sources are ARCHIVED, not deleted: a merge is a judgement call, and the
 * originals staying readable is what makes it reversible. Archiving happens
 * after the replacement is live so recall never sees a gap.
 *
 * The result is approved outright when every source was already approved. That
 * is not a hole in the approval gate — the gate exists so nothing the *model*
 * produced is remembered without a human saying yes, and here a human has
 * approved every input and typed the output. If any source was still pending,
 * the merge lands pending too.
 */
export async function mergeMemories(opts: {
  ids: string[];
  content: string;
  category?: MemoryCategory;
  packId?: string | null;
  factKey?: string | null;
}): Promise<MemoryItem> {
  if (opts.ids.length < 2) throw new Error('Pick at least two memories to merge.');
  const sources = opts.ids.map((id) => {
    const m = memoriesRepo.get(id);
    if (!m) throw new Error('Memory not found');
    return m;
  });
  const profileId = sources[0].profileId;
  if (sources.some((s) => s.profileId !== profileId)) {
    throw new Error('Those memories belong to different profiles.');
  }
  const content = opts.content.trim();
  if (content.length < 3) throw new Error('A memory needs some content.');
  const verdict = checkSensitive(content);
  if (verdict.sensitive) {
    throw new Error(`This looks like ${verdict.reason} data — BrainCue won't store it as memory.`);
  }

  // Scope: keep it when every source agrees, otherwise fall back to global —
  // text merged from a global memory is global, and pinning it to one Space
  // would quietly lose it everywhere else.
  const scopes = new Set(sources.map((s) => s.packId));
  const packId =
    opts.packId !== undefined ? opts.packId : scopes.size === 1 ? sources[0].packId : null;

  const id = memoriesRepo.insertCandidate({
    profileId,
    packId,
    category: opts.category ?? sources[0].category,
    content,
    confidence: 1, // the user wrote this sentence themselves
    importance: Math.max(...sources.map((s) => s.importance)),
    sourceRefs: sources.map((s) => ({ type: 'memory', id: s.id })),
    factKey: opts.factKey ?? null,
    sourceKind: 'derived',
  });
  for (const s of sources) {
    for (const link of entitiesRepo.linksFor(s.id)) entitiesRepo.link(id, link.entityId, link.role);
  }

  if (sources.every((s) => s.status === 'approved')) {
    await approveAllOrRollback([id]); // may also supersede a fact this replaces
  }
  for (const s of sources) memoriesRepo.setStatus(s.id, 'archived');
  return memoriesRepo.get(id)!;
}

/**
 * Break one memory into several (docs/14-MEMORY.md §3.5) — the fix for a
 * candidate that bundled three facts into one sentence and is therefore
 * recalled for none of them cleanly.
 *
 * The parts do NOT inherit `factKey`. A single-valued fact that splits into
 * several statements is by definition no longer single-valued, and copying the
 * key onto each part would put several current rows under one key — exactly the
 * one-truth invariant supersession exists to hold (§3.1). Re-key the part that
 * still owns the fact by editing it.
 */
export async function splitMemory(opts: { id: string; parts: string[] }): Promise<MemoryItem[]> {
  const source = memoriesRepo.get(opts.id);
  if (!source) throw new Error('Memory not found');
  const parts = opts.parts.map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('A split needs at least two parts.');

  // Check every part before writing any of them — a split that stops halfway
  // through leaves the user worse off than one that refuses.
  for (const part of parts) {
    if (part.length < 3) throw new Error('Each part needs some content.');
    const verdict = checkSensitive(part);
    if (verdict.sensitive) {
      throw new Error(
        `One of those parts looks like ${verdict.reason} data — BrainCue won't store it as memory.`,
      );
    }
  }

  const links = entitiesRepo.linksFor(source.id);
  const ids = parts.map((content) => {
    const id = memoriesRepo.insertCandidate({
      profileId: source.profileId,
      packId: source.packId,
      category: source.category,
      content,
      confidence: source.confidence,
      importance: source.importance,
      sourceRefs: [{ type: 'memory', id: source.id }],
      factKey: null,
      sourceKind: 'derived',
    });
    for (const link of links) entitiesRepo.link(id, link.entityId, link.role);
    return id;
  });

  if (source.status === 'approved') await approveAllOrRollback(ids);
  memoriesRepo.setStatus(source.id, 'archived');
  return ids.map((id) => memoriesRepo.get(id)!);
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
