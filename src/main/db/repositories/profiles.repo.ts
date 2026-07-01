import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../index';
import type { Profile, ProfileInput } from '@shared/types';

type Row = typeof schema.profiles.$inferSelect;

// The `answer_style` DB column is retained (NOT NULL default 'concise') but no longer
// read or written — the answer format is a single live Cue Card control now (v1.2).
function toProfile(r: Row): Profile {
  return {
    id: r.id,
    name: r.name,
    targetRole: r.targetRole,
    targetCompany: r.targetCompany,
    interviewType: r.interviewType as Profile['interviewType'],
    language: r.language,
    resumeText: r.resumeText,
    jdText: r.jdText,
    parsedResume: r.parsedResume ? JSON.parse(r.parsedResume) : null,
    parsedJd: r.parsedJd ? JSON.parse(r.parsedJd) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const profilesRepo = {
  list(): Profile[] {
    return db()
      .select()
      .from(schema.profiles)
      .orderBy(desc(schema.profiles.updatedAt))
      .all()
      .map(toProfile);
  },

  get(id: string): Profile | null {
    const r = db().select().from(schema.profiles).where(eq(schema.profiles.id, id)).get();
    return r ? toProfile(r) : null;
  },

  create(input: ProfileInput): Profile {
    const id = crypto.randomUUID();
    db()
      .insert(schema.profiles)
      .values({
        id,
        name: input.name,
        targetRole: input.targetRole,
        targetCompany: input.targetCompany,
        interviewType: input.interviewType,
        language: input.language,
        resumeText: input.resumeText,
        jdText: input.jdText,
      })
      .run();
    return this.get(id)!;
  },

  update(id: string, patch: Partial<Profile>): Profile {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    const map: Record<string, unknown> = {
      name: patch.name,
      targetRole: patch.targetRole,
      targetCompany: patch.targetCompany,
      interviewType: patch.interviewType,
      language: patch.language,
      resumeText: patch.resumeText,
      jdText: patch.jdText,
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) set[k] = v;
    if (patch.parsedResume !== undefined)
      set.parsedResume = patch.parsedResume ? JSON.stringify(patch.parsedResume) : null;
    if (patch.parsedJd !== undefined)
      set.parsedJd = patch.parsedJd ? JSON.stringify(patch.parsedJd) : null;

    db().update(schema.profiles).set(set).where(eq(schema.profiles.id, id)).run();
    return this.get(id)!;
  },

  delete(id: string): void {
    // FK cascade removes documents, notes, chunks, embeddings, sessions, etc.
    db().delete(schema.profiles).where(eq(schema.profiles.id, id)).run();
  },

  count(): number {
    return db().select().from(schema.profiles).all().length;
  },

  /** Delete every profile. FK cascade wipes all dependent rows (documents,
   *  notes, jobs, chunks, embeddings, sessions and their children). */
  deleteAll(): void {
    db().delete(schema.profiles).run();
  },
};
