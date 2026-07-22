import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../index';
import type { Contribution } from '@shared/types';

type Row = typeof schema.contributions.$inferSelect;

function toContribution(r: Row): Contribution {
  return {
    id: r.id,
    sessionId: r.sessionId,
    kind: r.kind as Contribution['kind'],
    status: r.status as Contribution['status'],
    title: r.title,
    body: r.body,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    sourceRefs: r.sourceRefs
      ? (JSON.parse(r.sourceRefs) as { type: string; id: string }[])
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The generic contributions store (v2). Writes during a live session go
 *  through enginePersistence; this repo serves review/report surfaces. */
export const contributionsRepo = {
  listBySession(sessionId: string): Contribution[] {
    return db()
      .select()
      .from(schema.contributions)
      .where(eq(schema.contributions.sessionId, sessionId))
      .orderBy(desc(schema.contributions.createdAt))
      .all()
      .map(toContribution);
  },

  get(id: string): Contribution | null {
    const r = db()
      .select()
      .from(schema.contributions)
      .where(eq(schema.contributions.id, id))
      .get();
    return r ? toContribution(r) : null;
  },

  /** Review edits: title/body/meta/status. Only the provided fields change. */
  update(
    id: string,
    patch: {
      title?: string | null;
      body?: string;
      meta?: Record<string, unknown> | null;
      status?: Contribution['status'];
    },
  ): Contribution {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.meta !== undefined) set.meta = patch.meta ? JSON.stringify(patch.meta) : null;
    if (patch.status !== undefined) set.status = patch.status;
    db().update(schema.contributions).set(set).where(eq(schema.contributions.id, id)).run();
    const updated = this.get(id);
    if (!updated) throw new Error('Contribution not found');
    return updated;
  },
};
