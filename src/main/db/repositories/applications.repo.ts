import { desc, eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../index';
import { jobsRepo } from './jobs.repo';
import type { Application, ApplicationAnswer, ApplicationListItem } from '@shared/types';

type Row = typeof schema.applications.$inferSelect;

function toApplication(r: Row): Application {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.packId, // shared field name kept for IPC compatibility
    name: r.name,
    jobTitle: r.jobTitle,
    company: r.company,
    baseResume: r.baseResume,
    tailoredResume: r.tailoredResume,
    answers: r.answers ? (JSON.parse(r.answers) as ApplicationAnswer[]) : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const applicationsRepo = {
  get(id: string): Application | null {
    const r = db().select().from(schema.applications).where(eq(schema.applications.id, id)).get();
    return r ? toApplication(r) : null;
  },

  /** The application that owns a pack (if any) — used by indexJob to pick up the
   *  tailored resume as `tailored` chunks, and by pack list filtering. */
  getByJobId(packId: string): Application | null {
    const r = db()
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.packId, packId))
      .get();
    return r ? toApplication(r) : null;
  },

  create(input: {
    profileId: string;
    jobId: string;
    name: string;
    jobTitle: string;
    company: string | null;
    baseResume: string;
    tailoredResume: string;
    answers: ApplicationAnswer[];
  }): Application {
    const id = crypto.randomUUID();
    db()
      .insert(schema.applications)
      .values({
        id,
        profileId: input.profileId,
        packId: input.jobId,
        name: input.name,
        jobTitle: input.jobTitle,
        company: input.company,
        baseResume: input.baseResume,
        tailoredResume: input.tailoredResume,
        answers: JSON.stringify(input.answers),
      })
      .run();
    return this.get(id)!;
  },

  /** A page of applications across ALL profiles, newest first, optionally filtered
   *  by a search over name/title/company. Server-side LIMIT/OFFSET (see jobs.page). */
  page(opts: { query?: string; limit: number; offset: number }): {
    items: ApplicationListItem[];
    total: number;
  } {
    const q = (opts.query ?? '').trim();
    const where = q
      ? or(
          like(schema.applications.name, `%${q}%`),
          like(schema.applications.jobTitle, `%${q}%`),
          like(schema.applications.company, `%${q}%`),
        )
      : undefined;

    const items = db()
      .select({
        row: schema.applications,
        profileName: schema.profiles.name,
      })
      .from(schema.applications)
      .leftJoin(schema.profiles, eq(schema.profiles.id, schema.applications.profileId))
      .where(where)
      .orderBy(desc(schema.applications.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all()
      .map((r) => ({ ...toApplication(r.row), profileName: r.profileName ?? null }));

    const total =
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.applications)
        .where(where)
        .get()?.c ?? 0;
    return { items, total };
  },

  /** Append newly answered application questions (asked after tailoring). */
  appendAnswers(id: string, answers: ApplicationAnswer[]): Application {
    const app = this.get(id);
    if (!app) throw new Error('Application not found');
    db()
      .update(schema.applications)
      .set({ answers: JSON.stringify([...app.answers, ...answers]), updatedAt: Date.now() })
      .where(eq(schema.applications.id, id))
      .run();
    return this.get(id)!;
  },

  /** Delete an application AND its dedicated job (JD/company/tailored chunks +
   *  embeddings; sessions keep their history with jobId nulled — same semantics as
   *  deleting a job). The app row is removed explicitly too, so this works whether
   *  or not the DB enforces the ON DELETE cascade from jobs. */
  delete(id: string): void {
    const app = this.get(id);
    if (!app) return;
    jobsRepo.delete(app.jobId);
    db().delete(schema.applications).where(eq(schema.applications.id, id)).run();
  },
};
