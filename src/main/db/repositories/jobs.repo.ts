import { and, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { db, schema } from '../index';
import type { Job } from '@shared/types';

type Row = typeof schema.jobs.$inferSelect;

/** Jobs owned by an application (Tailor Resume) are managed from the Applications
 *  table — hide them from the regular Interviews list/page so they don't
 *  double-surface (and can't be deleted out from under their application). */
const notApplicationOwned = () =>
  notInArray(schema.jobs.id, db().select({ id: schema.applications.jobId }).from(schema.applications));

function toJob(r: Row): Job {
  return {
    id: r.id,
    profileId: r.profileId,
    title: r.title,
    company: r.company,
    jdUrl: r.jdUrl,
    jdText: r.jdText,
    parsedJd: r.parsedJd ? JSON.parse(r.parsedJd) : null,
    companyUrl: r.companyUrl,
    companyResearch: r.companyResearch,
    parsedCompany: r.parsedCompany ? JSON.parse(r.parsedCompany) : null,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const jobsRepo = {
  list(profileId: string): Job[] {
    return db()
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.profileId, profileId), notApplicationOwned()))
      .orderBy(desc(schema.jobs.updatedAt))
      .all()
      .map(toJob);
  },

  get(id: string): Job | null {
    const r = db().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    return r ? toJob(r) : null;
  },

  /** Total interviews (jobs) across all profiles — for the sidebar stats. Excludes
   *  application-owned jobs (those are counted as applications, not interviews). */
  count(): number {
    return (
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.jobs)
        .where(notApplicationOwned())
        .get()?.c ?? 0
    );
  },

  /** A page of jobs for a profile, newest first, optionally filtered by a search
   *  over title + company. Server-side LIMIT/OFFSET so the UI never loads them all. */
  page(opts: { profileId: string; query?: string; limit: number; offset: number }): {
    items: Job[];
    total: number;
  } {
    const q = (opts.query ?? '').trim();
    const base = and(eq(schema.jobs.profileId, opts.profileId), notApplicationOwned());
    const where = q
      ? and(base, or(like(schema.jobs.title, `%${q}%`), like(schema.jobs.company, `%${q}%`)))
      : base;
    const items = db()
      .select()
      .from(schema.jobs)
      .where(where)
      .orderBy(desc(schema.jobs.updatedAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all()
      .map(toJob);
    const total =
      db().select({ c: sql<number>`count(*)` }).from(schema.jobs).where(where).get()?.c ?? 0;
    return { items, total };
  },

  create(input: {
    profileId: string;
    title: string;
    company: string | null;
    jdUrl: string | null;
    jdText: string | null;
    companyUrl: string | null;
    notes: string | null;
  }): Job {
    const id = crypto.randomUUID();
    db()
      .insert(schema.jobs)
      .values({
        id,
        profileId: input.profileId,
        title: input.title,
        company: input.company,
        jdUrl: input.jdUrl,
        jdText: input.jdText,
        companyUrl: input.companyUrl,
        notes: input.notes,
      })
      .run();
    return this.get(id)!;
  },

  update(id: string, patch: Partial<Job>): Job {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.company !== undefined) set.company = patch.company;
    if (patch.jdUrl !== undefined) set.jdUrl = patch.jdUrl;
    if (patch.jdText !== undefined) set.jdText = patch.jdText;
    if (patch.parsedJd !== undefined)
      set.parsedJd = patch.parsedJd ? JSON.stringify(patch.parsedJd) : null;
    if (patch.companyUrl !== undefined) set.companyUrl = patch.companyUrl;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.companyResearch !== undefined) set.companyResearch = patch.companyResearch;
    if (patch.parsedCompany !== undefined)
      set.parsedCompany = patch.parsedCompany ? JSON.stringify(patch.parsedCompany) : null;
    db().update(schema.jobs).set(set).where(eq(schema.jobs.id, id)).run();
    return this.get(id)!;
  },

  delete(id: string): void {
    // Delete dependents explicitly (and detach sessions) in a transaction. Older
    // DBs were created before the jobs FKs gained ON DELETE cascade/set-null, and
    // SQLite fixes FK actions at table-creation time — so a plain delete trips a
    // FOREIGN KEY constraint when the job has JD/company chunks. Doing it by hand
    // works regardless of the live schema's FK actions.
    db().transaction((tx) => {
      const chunkIds = tx
        .select({ id: schema.chunks.id })
        .from(schema.chunks)
        .where(eq(schema.chunks.jobId, id))
        .all()
        .map((r) => r.id);
      if (chunkIds.length) {
        tx.delete(schema.embeddings).where(inArray(schema.embeddings.chunkId, chunkIds)).run();
      }
      tx.delete(schema.chunks).where(eq(schema.chunks.jobId, id)).run();
      tx.update(schema.sessions).set({ jobId: null }).where(eq(schema.sessions.jobId, id)).run();
      tx.delete(schema.jobs).where(eq(schema.jobs.id, id)).run();
    });
  },
};
