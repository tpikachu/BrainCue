import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import { db, schema } from '../index';
import type { MemoryCategory, MemoryItem, MemoryStatus } from '@shared/types';

type Row = typeof schema.memories.$inferSelect;

function toItem(r: Row): MemoryItem {
  return {
    id: r.id,
    profileId: r.profileId,
    packId: r.packId,
    category: r.category as MemoryCategory,
    content: r.content,
    sourceRefs: r.sourceRefs ? (JSON.parse(r.sourceRefs) as { type: string; id: string }[]) : null,
    confidence: r.confidence,
    importance: r.importance,
    sensitive: r.sensitive === 1,
    status: r.status as MemoryStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
  };
}

/** CRUD + lifecycle for local memory. The embedding lives ON the row, so
 *  delete removes the memory AND its vector atomically (nothing orphaned).
 *  Embedding/consent orchestration lives in services/memory. */
export const memoriesRepo = {
  list(opts: {
    profileId: string;
    status?: MemoryStatus;
    query?: string;
    packId?: string | null; // undefined = all scopes
  }): MemoryItem[] {
    const conds = [eq(schema.memories.profileId, opts.profileId)];
    if (opts.status) conds.push(eq(schema.memories.status, opts.status));
    if (opts.query?.trim()) conds.push(like(schema.memories.content, `%${opts.query.trim()}%`));
    if (opts.packId !== undefined) {
      // packId null = global-only; a string = that Space only.
      conds.push(
        opts.packId === null
          ? isNull(schema.memories.packId)
          : eq(schema.memories.packId, opts.packId),
      );
    }
    return db()
      .select()
      .from(schema.memories)
      .where(and(...conds))
      .orderBy(desc(schema.memories.updatedAt))
      .all()
      .map(toItem);
  },

  get(id: string): MemoryItem | null {
    const r = db().select().from(schema.memories).where(eq(schema.memories.id, id)).get();
    return r ? toItem(r) : null;
  },

  insertCandidate(opts: {
    profileId: string;
    packId: string | null;
    category: MemoryCategory;
    content: string;
    confidence: number;
    importance: number;
    sourceRefs: { type: string; id: string }[];
  }): string {
    const id = crypto.randomUUID();
    db()
      .insert(schema.memories)
      .values({
        id,
        profileId: opts.profileId,
        packId: opts.packId,
        category: opts.category,
        content: opts.content,
        confidence: opts.confidence,
        importance: opts.importance,
        status: 'pending',
        sourceRefs: JSON.stringify(opts.sourceRefs),
      })
      .run();
    return id;
  },

  /** Approve (optionally with edits) + attach the embedding computed by the
   *  service layer. Only approved rows ever participate in recall. */
  approve(
    id: string,
    opts: {
      content: string;
      category: MemoryCategory;
      packId: string | null;
      embedding: { provider: string; model: string; dim: number; vector: Buffer };
    },
  ): MemoryItem {
    db()
      .update(schema.memories)
      .set({
        status: 'approved',
        content: opts.content,
        category: opts.category,
        packId: opts.packId,
        embedProvider: opts.embedding.provider,
        embedModel: opts.embedding.model,
        embedDim: opts.embedding.dim,
        embedVector: opts.embedding.vector,
        updatedAt: Date.now(),
      })
      .where(eq(schema.memories.id, id))
      .run();
    return this.get(id)!;
  },

  setStatus(id: string, status: MemoryStatus): MemoryItem {
    db()
      .update(schema.memories)
      .set({ status, updatedAt: Date.now() })
      .where(eq(schema.memories.id, id))
      .run();
    const updated = this.get(id);
    if (!updated) throw new Error('Memory not found');
    return updated;
  },

  /** Field edits (content/category/importance/expiry/scope). Content edits on
   *  approved rows must re-embed — the SERVICE enforces that. */
  update(
    id: string,
    patch: {
      content?: string;
      category?: MemoryCategory;
      importance?: number;
      packId?: string | null;
      expiresAt?: number | null;
      embedding?: { provider: string; model: string; dim: number; vector: Buffer } | null;
    },
  ): MemoryItem {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.importance !== undefined) set.importance = patch.importance;
    if (patch.packId !== undefined) set.packId = patch.packId;
    if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
    if (patch.embedding !== undefined) {
      set.embedProvider = patch.embedding?.provider ?? null;
      set.embedModel = patch.embedding?.model ?? null;
      set.embedDim = patch.embedding?.dim ?? null;
      set.embedVector = patch.embedding?.vector ?? null;
    }
    db().update(schema.memories).set(set).where(eq(schema.memories.id, id)).run();
    const updated = this.get(id);
    if (!updated) throw new Error('Memory not found');
    return updated;
  },

  /** Hard delete: the row carries its own vector, so this removes the memory
   *  and its embedding in one statement — the deletion cascade the privacy
   *  contract requires. */
  delete(id: string): void {
    db().delete(schema.memories).where(eq(schema.memories.id, id)).run();
  },

  /** Recall inputs: approved, in-scope (global + this Space), unexpired,
   *  embedded. Raw rows — the recall service scores them. */
  recallRows(profileId: string, packId: string | null, now: number): Row[] {
    return db()
      .select()
      .from(schema.memories)
      .where(
        and(eq(schema.memories.profileId, profileId), eq(schema.memories.status, 'approved')),
      )
      .all()
      .filter(
        (r) =>
          (r.packId == null || r.packId === packId) &&
          (r.expiresAt == null || r.expiresAt > now) &&
          r.embedVector != null,
      );
  },

  markUsed(ids: string[], now: number): void {
    if (ids.length === 0) return;
    db()
      .update(schema.memories)
      .set({ lastUsedAt: now })
      .where(inArray(schema.memories.id, ids))
      .run();
  },
};
