import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../index';
import type { Entity, EntityKind, MemoryItem } from '@shared/types';

type Row = typeof schema.entities.$inferSelect;

/** Match key: case- and punctuation-insensitive, so "Acme Corp.", "acme corp"
 *  and "ACME  Corp" all resolve to one entity without fuzzy matching. */
export function matchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEntity(r: Row): Entity {
  return {
    id: r.id,
    profileId: r.profileId,
    kind: r.kind as EntityKind,
    canonicalName: r.canonicalName,
    aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
    summary: r.summary,
    importance: r.importance,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    mergedInto: r.mergedInto,
  };
}

/**
 * Entities and their links to memories (docs/14-MEMORY.md §3.2).
 *
 * Resolution is EXACT on the match key or a registered alias. Nothing fuzzy
 * happens automatically: two people called Sarah must not silently become one,
 * because that corruption is nearly invisible afterwards and cannot be undone
 * from the merged rows alone. `merge()` is a user action, and it is
 * non-destructive — the losing entity keeps pointing at the winner.
 */
export const entitiesRepo = {
  /** Live entities only (merged ones resolve through their winner). */
  list(profileId: string): Entity[] {
    const rows = db()
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.profileId, profileId), isNull(schema.entities.mergedInto)))
      .all();
    const counts = this.memoryCounts(rows.map((r) => r.id));
    return rows
      .map((r) => ({ ...toEntity(r), memoryCount: counts.get(r.id) ?? 0 }))
      .sort((a, b) => (b.memoryCount ?? 0) - (a.memoryCount ?? 0));
  },

  get(id: string): Entity | null {
    const r = db().select().from(schema.entities).where(eq(schema.entities.id, id)).get();
    return r ? toEntity(r) : null;
  },

  /** Follow a merge chain to the surviving entity (bounded — a cycle would
   *  otherwise hang recall). */
  resolve(id: string): Entity | null {
    let current = this.get(id);
    for (let hops = 0; current?.mergedInto && hops < 8; hops += 1) {
      current = this.get(current.mergedInto);
    }
    return current;
  },

  /** Find by canonical name or any alias, following merges. */
  findByName(profileId: string, name: string): Entity | null {
    const key = matchKey(name);
    if (!key) return null;
    const rows = db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.profileId, profileId))
      .all();
    const hit = rows.find((r) => {
      if (matchKey(r.canonicalName) === key) return true;
      const aliases = r.aliases ? (JSON.parse(r.aliases) as string[]) : [];
      return aliases.includes(key);
    });
    return hit ? this.resolve(hit.id) : null;
  },

  /** Find or create. Never merges — an unrecognised spelling becomes its own
   *  entity, which the user can merge later. Over-splitting is recoverable;
   *  over-merging is not. */
  upsertByName(opts: {
    profileId: string;
    name: string;
    kind: EntityKind;
    at?: number;
  }): Entity {
    const at = opts.at ?? Date.now();
    const existing = this.findByName(opts.profileId, opts.name);
    if (existing) {
      db()
        .update(schema.entities)
        .set({ lastSeenAt: at, updatedAt: at })
        .where(eq(schema.entities.id, existing.id))
        .run();
      return { ...existing, lastSeenAt: at };
    }
    const id = crypto.randomUUID();
    db()
      .insert(schema.entities)
      .values({
        id,
        profileId: opts.profileId,
        kind: opts.kind,
        canonicalName: opts.name.trim(),
        aliases: JSON.stringify([matchKey(opts.name)]),
        firstSeenAt: at,
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return this.get(id)!;
  },

  update(id: string, patch: { canonicalName?: string; kind?: EntityKind; summary?: string | null; importance?: number }): Entity {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.canonicalName !== undefined) set.canonicalName = patch.canonicalName.trim();
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.importance !== undefined) set.importance = patch.importance;
    db().update(schema.entities).set(set).where(eq(schema.entities.id, id)).run();
    const updated = this.get(id);
    if (!updated) throw new Error('Entity not found');
    return updated;
  },

  /**
   * Fold `loserId` into `winnerId`: memory links move, aliases combine, and
   * the loser is tombstoned rather than deleted so any stale reference still
   * resolves to the winner.
   */
  merge(loserId: string, winnerId: string, at = Date.now()): Entity {
    if (loserId === winnerId) throw new Error('Cannot merge an entity into itself');
    const loser = this.get(loserId);
    const winner = this.get(winnerId);
    if (!loser || !winner) throw new Error('Entity not found');
    if (loser.profileId !== winner.profileId) throw new Error('Entities belong to different profiles');

    const links = db()
      .select()
      .from(schema.memoryEntities)
      .where(eq(schema.memoryEntities.entityId, loserId))
      .all();
    const winnerMemories = new Set(
      db()
        .select()
        .from(schema.memoryEntities)
        .where(eq(schema.memoryEntities.entityId, winnerId))
        .all()
        .map((l) => l.memoryId),
    );
    for (const link of links) {
      if (!winnerMemories.has(link.memoryId)) {
        db()
          .insert(schema.memoryEntities)
          .values({ memoryId: link.memoryId, entityId: winnerId, role: link.role })
          .run();
      }
    }
    db().delete(schema.memoryEntities).where(eq(schema.memoryEntities.entityId, loserId)).run();

    const aliases = Array.from(
      new Set([...winner.aliases, ...loser.aliases, matchKey(loser.canonicalName)]),
    );
    db()
      .update(schema.entities)
      .set({ aliases: JSON.stringify(aliases), updatedAt: at })
      .where(eq(schema.entities.id, winnerId))
      .run();
    db()
      .update(schema.entities)
      .set({ mergedInto: winnerId, updatedAt: at })
      .where(eq(schema.entities.id, loserId))
      .run();

    return this.get(winnerId)!;
  },

  link(memoryId: string, entityId: string, role: 'subject' | 'mentioned' = 'mentioned'): void {
    const already = db()
      .select()
      .from(schema.memoryEntities)
      .where(
        and(
          eq(schema.memoryEntities.memoryId, memoryId),
          eq(schema.memoryEntities.entityId, entityId),
        ),
      )
      .get();
    if (already) return;
    db().insert(schema.memoryEntities).values({ memoryId, entityId, role }).run();
  },

  /** The entity links a memory carries. Merge and split use this to carry the
   *  structured path across: a memory rewritten by the user is still about the
   *  same people, and losing that silently would make entity questions start
   *  missing answers with nothing to point at. */
  linksFor(memoryId: string): { entityId: string; role: 'subject' | 'mentioned' }[] {
    return db()
      .select()
      .from(schema.memoryEntities)
      .where(eq(schema.memoryEntities.memoryId, memoryId))
      .all()
      .map((l) => ({ entityId: l.entityId, role: l.role as 'subject' | 'mentioned' }));
  },

  /** How many CURRENT memories each entity has — superseded and rejected rows
   *  are excluded so the count matches what recall can actually use. */
  memoryCounts(entityIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (entityIds.length === 0) return out;
    const rows = db()
      .select({
        entityId: schema.memoryEntities.entityId,
        status: schema.memories.status,
        supersededBy: schema.memories.supersededBy,
      })
      .from(schema.memoryEntities)
      .innerJoin(schema.memories, eq(schema.memories.id, schema.memoryEntities.memoryId))
      .where(inArray(schema.memoryEntities.entityId, entityIds))
      .all();
    for (const r of rows) {
      if (r.status !== 'approved' || r.supersededBy != null) continue;
      out.set(r.entityId, (out.get(r.entityId) ?? 0) + 1);
    }
    return out;
  },

  /** The ids of current, approved memories linked to any of these entities —
   *  the structured retrieval path similarity search cannot provide. */
  currentMemoryIds(entityIds: string[], now = Date.now()): Set<string> {
    const out = new Set<string>();
    if (entityIds.length === 0) return out;
    const rows = db()
      .select({
        memoryId: schema.memoryEntities.memoryId,
        status: schema.memories.status,
        supersededBy: schema.memories.supersededBy,
        validTo: schema.memories.validTo,
        expiresAt: schema.memories.expiresAt,
      })
      .from(schema.memoryEntities)
      .innerJoin(schema.memories, eq(schema.memories.id, schema.memoryEntities.memoryId))
      .where(inArray(schema.memoryEntities.entityId, entityIds))
      .all();
    for (const r of rows) {
      if (r.status !== 'approved' || r.supersededBy != null) continue;
      if (r.validTo != null && r.validTo <= now) continue;
      if (r.expiresAt != null && r.expiresAt <= now) continue;
      out.add(r.memoryId);
    }
    return out;
  },

  /** Every current memory about an entity — powers the entity detail view. */
  memoriesFor(entityId: string, allMemories: MemoryItem[]): MemoryItem[] {
    const ids = this.currentMemoryIds([entityId]);
    return allMemories.filter((m) => ids.has(m.id));
  },
};
