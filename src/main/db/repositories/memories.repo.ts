import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import { db, schema } from '../index';
import type {
  MemoryCategory,
  MemoryConflict,
  MemoryItem,
  MemorySourceKind,
  MemoryStatus,
} from '@shared/types';

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
    factKey: r.factKey,
    validFrom: r.validFrom,
    validTo: r.validTo,
    supersededBy: r.supersededBy,
    sourceKind: r.sourceKind as MemorySourceKind,
    revision: r.revision,
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
    factKey?: string | null;
    sourceKind?: MemorySourceKind;
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
        factKey: opts.factKey ?? null,
        sourceKind: opts.sourceKind ?? 'extracted',
      })
      .run();
    return id;
  },

  /**
   * The CURRENT approved row for a single-valued fact, or null.
   *
   * "Current" = approved, same scope, not superseded, still valid. This is the
   * lookup the supersession invariant is built on: at most one such row may
   * exist per (profileId, packId, factKey).
   */
  currentByFactKey(
    profileId: string,
    packId: string | null,
    factKey: string,
    now = Date.now(),
  ): MemoryItem | null {
    const rows = db()
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.profileId, profileId),
          eq(schema.memories.factKey, factKey),
          eq(schema.memories.status, 'approved'),
          isNull(schema.memories.supersededBy),
        ),
      )
      .all()
      .filter(
        (r) =>
          (packId === null ? r.packId == null : r.packId === packId) &&
          (r.validTo == null || r.validTo > now),
      );
    // Defensive: if a bug ever produced two current rows, the newest wins so
    // recall still sees exactly one truth.
    rows.sort((a, b) => b.validFrom - a.validFrom);
    return rows[0] ? toItem(rows[0]) : null;
  },

  /**
   * Retire `oldId` in favour of `newId`: stamps validTo + supersededBy and
   * drops the embedding so the superseded row can never be recalled again,
   * while the row itself (and its content) survives as history.
   */
  supersede(oldId: string, newId: string, at = Date.now()): void {
    db()
      .update(schema.memories)
      .set({
        supersededBy: newId,
        validTo: at,
        updatedAt: at,
        // Recall filters on supersededBy already; clearing the vector is the
        // belt-and-braces version — a superseded fact is unreachable even if a
        // future retrieval path forgets the filter.
        embedVector: null,
        embedProvider: null,
        embedModel: null,
        embedDim: null,
      })
      .where(eq(schema.memories.id, oldId))
      .run();
  },

  /** The revision number a replacement should carry (previous + 1). */
  nextRevision(previous: MemoryItem): number {
    return previous.revision + 1;
  },

  /** Set the revision on a row being promoted over a superseded predecessor. */
  setRevision(id: string, revision: number): void {
    db().update(schema.memories).set({ revision }).where(eq(schema.memories.id, id)).run();
  },

  /**
   * Pending candidates that would REPLACE a current approved fact, paired with
   * what they'd replace. The review UI shows both so the user decides; nothing
   * is ever superseded automatically.
   */
  conflicts(profileId: string, now = Date.now()): MemoryConflict[] {
    const pending = db()
      .select()
      .from(schema.memories)
      .where(
        and(eq(schema.memories.profileId, profileId), eq(schema.memories.status, 'pending')),
      )
      .all()
      .filter((r) => r.factKey);
    const out: MemoryConflict[] = [];
    for (const p of pending) {
      const current = this.currentByFactKey(profileId, p.packId, p.factKey as string, now);
      if (current && current.id !== p.id) out.push({ candidate: toItem(p), current });
    }
    return out;
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
   *  CURRENT (not superseded, still valid), embedded. Raw rows — the recall
   *  service scores them.
   *
   *  The supersession filter is enforced HERE, at the repository layer, so no
   *  caller can accidentally ground an answer in a fact the user has replaced
   *  (docs/14-MEMORY.md §4). */
  recallRows(profileId: string, packId: string | null, now: number): Row[] {
    return db()
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.profileId, profileId),
          eq(schema.memories.status, 'approved'),
          isNull(schema.memories.supersededBy),
        ),
      )
      .all()
      .filter(
        (r) =>
          (r.packId == null || r.packId === packId) &&
          (r.expiresAt == null || r.expiresAt > now) &&
          (r.validTo == null || r.validTo > now) &&
          r.embedVector != null,
      );
  },

  /** A fact's revision chain, newest first — what the value is now and what it
   *  used to be. Powers the history view; never feeds recall. */
  history(profileId: string, factKey: string): MemoryItem[] {
    return db()
      .select()
      .from(schema.memories)
      .where(
        and(eq(schema.memories.profileId, profileId), eq(schema.memories.factKey, factKey)),
      )
      .all()
      .map(toItem)
      .sort((a, b) => b.validFrom - a.validFrom);
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
