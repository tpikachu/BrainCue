import { and, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { db, schema } from '../index';
import type { ContextPack, ContextPackKind } from '@shared/types';

type Row = typeof schema.contextPacks.$inferSelect;

/** Packs owned by an application (Tailor Resume) are managed from the Applications
 *  table — hide them from the regular Interviews list/page so they don't
 *  double-surface (and can't be deleted out from under their application). */
const notApplicationOwned = () =>
  notInArray(
    schema.contextPacks.id,
    db().select({ id: schema.applications.packId }).from(schema.applications),
  );

function toPack(r: Row): ContextPack {
  return {
    id: r.id,
    profileId: r.profileId,
    kind: r.kind as ContextPackKind,
    title: r.title,
    company: r.company,
    jdUrl: r.jdUrl,
    jdText: r.jdText,
    parsedJd: r.parsedJd ? JSON.parse(r.parsedJd) : null,
    companyUrl: r.companyUrl,
    companyResearch: r.companyResearch,
    parsedCompany: r.parsedCompany ? JSON.parse(r.parsedCompany) : null,
    notes: r.notes,
    memoryEnabled: r.memoryEnabled === 1,
    companionPrefs: r.companionPrefs ? JSON.parse(r.companionPrefs) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Context Packs ("Spaces" in the UI) — v1's jobs generalized. All v1 rows are
 *  kind 'job'; the list/page/count views below are the interview-flavored ones
 *  the current UI uses and therefore filter application-owned packs. */
export const contextPacksRepo = {
  list(profileId: string): ContextPack[] {
    return db()
      .select()
      .from(schema.contextPacks)
      .where(and(eq(schema.contextPacks.profileId, profileId), notApplicationOwned()))
      .orderBy(desc(schema.contextPacks.updatedAt))
      .all()
      .map(toPack);
  },

  get(id: string): ContextPack | null {
    const r = db().select().from(schema.contextPacks).where(eq(schema.contextPacks.id, id)).get();
    return r ? toPack(r) : null;
  },

  /** Per-Space memory opt-out (Library › Memory). */
  setMemoryEnabled(id: string, enabled: boolean): void {
    db()
      .update(schema.contextPacks)
      .set({ memoryEnabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(schema.contextPacks.id, id))
      .run();
  },

  /** Per-Space companion behavior overrides (null clears → inherit global). */
  setCompanionPrefs(id: string, prefs: ContextPack['companionPrefs']): ContextPack {
    db()
      .update(schema.contextPacks)
      .set({ companionPrefs: prefs ? JSON.stringify(prefs) : null, updatedAt: Date.now() })
      .where(eq(schema.contextPacks.id, id))
      .run();
    return this.get(id)!;
  },

  /** Total interviews (job packs) across all profiles — for the sidebar stats.
   *  Excludes application-owned packs (counted as applications, not interviews). */
  count(): number {
    return (
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.contextPacks)
        .where(notApplicationOwned())
        .get()?.c ?? 0
    );
  },

  /** A page of packs for a profile, newest first, optionally filtered by a search
   *  over title + company. Server-side LIMIT/OFFSET so the UI never loads them all. */
  page(opts: { profileId: string; query?: string; limit: number; offset: number }): {
    items: ContextPack[];
    total: number;
  } {
    const q = (opts.query ?? '').trim();
    const base = and(eq(schema.contextPacks.profileId, opts.profileId), notApplicationOwned());
    const where = q
      ? and(
          base,
          or(like(schema.contextPacks.title, `%${q}%`), like(schema.contextPacks.company, `%${q}%`)),
        )
      : base;
    const items = db()
      .select()
      .from(schema.contextPacks)
      .where(where)
      .orderBy(desc(schema.contextPacks.updatedAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all()
      .map(toPack);
    const total =
      db().select({ c: sql<number>`count(*)` }).from(schema.contextPacks).where(where).get()?.c ??
      0;
    return { items, total };
  },

  create(input: {
    profileId: string;
    kind?: ContextPackKind;
    title: string;
    company: string | null;
    jdUrl: string | null;
    jdText: string | null;
    companyUrl: string | null;
    notes: string | null;
  }): ContextPack {
    const id = crypto.randomUUID();
    db()
      .insert(schema.contextPacks)
      .values({
        id,
        profileId: input.profileId,
        kind: input.kind ?? 'job',
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

  update(id: string, patch: Partial<ContextPack>): ContextPack {
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
    db().update(schema.contextPacks).set(set).where(eq(schema.contextPacks.id, id)).run();
    return this.get(id)!;
  },

  delete(id: string): void {
    // Delete dependents explicitly (and detach sessions) in a transaction. Older
    // DBs were created before the pack FKs gained ON DELETE cascade/set-null, and
    // SQLite fixes FK actions at table-creation time — so a plain delete trips a
    // FOREIGN KEY constraint when the pack has JD/company chunks. Doing it by hand
    // works regardless of the live schema's FK actions.
    db().transaction((tx) => {
      const chunkIds = tx
        .select({ id: schema.chunks.id })
        .from(schema.chunks)
        .where(eq(schema.chunks.packId, id))
        .all()
        .map((r) => r.id);
      if (chunkIds.length) {
        tx.delete(schema.embeddings).where(inArray(schema.embeddings.chunkId, chunkIds)).run();
      }
      tx.delete(schema.chunks).where(eq(schema.chunks.packId, id)).run();
      tx.update(schema.sessions).set({ packId: null }).where(eq(schema.sessions.packId, id)).run();
      tx.delete(schema.contextPacks).where(eq(schema.contextPacks.id, id)).run();
    });
  },
};

/** @deprecated v1 name — use {@link contextPacksRepo}. */
export const jobsRepo = contextPacksRepo;
