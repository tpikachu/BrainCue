import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a profile re-index owns — and what it must leave alone.
 *
 * `reindexProfile` clears every unscoped chunk for the profile before writing
 * fresh ones. That set has grown twice: STAR stories are managed separately,
 * and conversation archives (docs/16-CONTINUITY.md) used to be unscoped when the
 * session had no Space. Without an explicit exclusion, editing your name would
 * silently erase every memory of every call you have ever had — a data-loss bug
 * with no error and no symptom until an answer quietly stops citing last week.
 *
 * Archives are always Space-scoped now (§15), so new ones are out of reach of
 * this delete anyway. The exclusion still matters and is still keyed on
 * `source_type`: every archive written before that rule is unscoped and still
 * sitting in existing databases.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  identity: { provider: 'fake', model: 'test-embed', dim: 4 },
  keyPresent: true,
}));

const fakeVec = (text: string) =>
  Float32Array.from([text.length % 3, (text.length + 1) % 3, 1, 0.05]);

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return {
    schema,
    db: () => {
      if (!h.db) throw new Error('test db not initialized');
      return h.db;
    },
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});
vi.mock('../security/apiKey', () => ({ apiKeyStore: { isPresent: () => h.keyPresent } }));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    identity: () => h.identity,
    embed: async (texts: string[]) => texts.map(fakeVec),
    embedOne: async (text: string) => fakeVec(text),
  }),
}));

import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { indexJob, reindexProfile } from './indexProfile';
import { sqliteVectorStore } from './vectorStore';
import { retrieve } from './retriever';
import { EMPTY_PROFILE_ABOUT, PROFILE_ABOUT_FIELDS } from '@shared/types';

let seq = 0;

function seedProfile(over: Partial<typeof schema.profiles.$inferInsert> = {}): string {
  const id = `idx-p${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id, name: 'Sam', targetRole: 'PM', resumeText: 'Led the payments platform.', ...over })
    .run();
  return id;
}
function seedChunk(profileId: string, sourceType: string, content: string, packId: string | null = null) {
  const id = `idx-c${++seq}`;
  h.db
    .insert(schema.chunks)
    .values({ id, profileId, packId, sourceType, sourceId: 'src', ord: 0, content })
    .run();
  return id;
}
const chunksOf = (profileId: string, sourceType: string) =>
  h.db
    .select()
    .from(schema.chunks)
    .all()
    .filter((c) => c.profileId === profileId && c.sourceType === sourceType);

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.keyPresent = true;
});

describe('reindexProfile leaves what it does not own', () => {
  it('keeps conversation archives — editing a profile must not erase your calls', async () => {
    const pid = seedProfile();
    const archive = seedChunk(pid, 'session', 'Conversation on 2026-07-20 — Acme renewal.');
    seedChunk(pid, 'resume', 'stale resume chunk');

    await reindexProfile(pid);

    expect(chunksOf(pid, 'session').map((c) => c.id)).toEqual([archive]);
    // …while the chunks it DOES own were genuinely rebuilt, not merely kept.
    expect(chunksOf(pid, 'resume').map((c) => c.content)).not.toContain('stale resume chunk');
    expect(chunksOf(pid, 'resume').length).toBeGreaterThan(0);
  });

  it('keeps the curated STAR story bank', async () => {
    const pid = seedProfile();
    const story = seedChunk(pid, 'story', 'A time I led a migration.');
    await reindexProfile(pid);
    expect(chunksOf(pid, 'story').map((c) => c.id)).toEqual([story]);
  });
});

describe('“about you” is indexed so it can actually ground an answer', () => {
  it('writes one self-contained chunk per answered section', async () => {
    const pid = seedProfile({
      about: JSON.stringify({
        ...EMPTY_PROFILE_ABOUT,
        role: 'Product manager for the payments platform',
        people: 'Sarah Chen is my manager.',
      }),
    });

    await reindexProfile(pid);

    const profileChunks = chunksOf(pid, 'profile');
    expect(profileChunks).toHaveLength(2); // only the ANSWERED sections
    // Each chunk names the person and what the section is, so a retrieved
    // fragment reads as a statement about them rather than a loose sentence.
    for (const c of profileChunks) {
      expect(c.content.startsWith('Sam — ')).toBe(true);
      expect(PROFILE_ABOUT_FIELDS.some((f) => c.content.includes(f.lead))).toBe(true);
    }
    expect(profileChunks.map((c) => c.content).join(' ')).toContain('Sarah Chen');
  });

  it('writes nothing for a profile that has not filled it in', async () => {
    const pid = seedProfile();
    await reindexProfile(pid);
    expect(chunksOf(pid, 'profile')).toHaveLength(0);
  });

  it('drops a section the user has cleared', async () => {
    const pid = seedProfile({
      about: JSON.stringify({ ...EMPTY_PROFILE_ABOUT, role: 'Product manager' }),
    });
    await reindexProfile(pid);
    expect(chunksOf(pid, 'profile')).toHaveLength(1);

    profilesRepo.update(pid, { about: { ...EMPTY_PROFILE_ABOUT, role: '' } });
    await reindexProfile(pid);
    expect(chunksOf(pid, 'profile')).toHaveLength(0);
  });
});

/**
 * A tailored résumé is a document OF a Space.
 *
 * It used to live only on an `application`, which owned a hidden pack of its
 * own — so it could never be attached to a Space the user actually had, and
 * "tailor my résumé for this interview" was unexpressible. Now the Space
 * carries it, and indexJob is what makes it groundable.
 */
describe('a Space carries its own tailored résumé', () => {
  function seedSpace(profileId: string, over: Partial<typeof schema.contextPacks.$inferInsert> = {}) {
    const id = `idx-j${++seq}`;
    h.db
      .insert(schema.contextPacks)
      .values({ id, profileId, kind: 'job', title: 'Staff PM', jdText: 'Own the roadmap.', ...over })
      .run();
    return id;
  }

  it('indexes it pack-scoped, alongside the JD rather than instead of it', async () => {
    const pid = seedProfile();
    const space = seedSpace(pid, { tailoredResume: 'Sam — rewritten for the Staff PM role.' });

    await indexJob(space);

    const tailored = chunksOf(pid, 'tailored');
    expect(tailored.length).toBeGreaterThan(0);
    // Scoped to the Space: this is what keeps one role's rewrite out of every
    // other conversation the profile has.
    expect(tailored.every((c) => c.packId === space)).toBe(true);
    expect(chunksOf(pid, 'jd').length).toBeGreaterThan(0); // the single pass keeps both
  });

  it('writes none when the Space has not been tailored', async () => {
    const pid = seedProfile();
    await indexJob(seedSpace(pid));
    expect(chunksOf(pid, 'tailored')).toHaveLength(0);
  });

  it('uses the supplied résumé only in its own Space, leaving the default and another role unchanged', async () => {
    const pid = seedProfile({ resumeText: 'Led the payments platform at Default Corp.' });
    const custom = seedSpace(pid, { resumeText: 'Scaled payments to 42k rps at Custom Corp.' });
    const other = seedSpace(pid);
    await reindexProfile(pid);
    await indexJob(custom);
    await indexJob(other);
    const own = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true });
    expect(own.some((c) => c.content.includes('42k rps'))).toBe(true);
    expect(own.some((c) => c.content.includes('Default Corp'))).toBe(false);
    const theirs = await retrieve(pid, 'payments', 10, other, { tailoredResume: true });
    expect(theirs.some((c) => c.content.includes('Default Corp'))).toBe(true);
    expect(theirs.some((c) => c.content.includes('Custom Corp'))).toBe(false);
    expect(profilesRepo.get(pid)?.resumeText).toBe('Led the payments platform at Default Corp.');
  });

  it('never reintroduces the embedded default when the Space résumé has no compatible embedding', async () => {
    const pid = seedProfile();
    await reindexProfile(pid);
    h.keyPresent = false;
    const custom = seedSpace(pid, { resumeText: 'Led payments at Custom Corp, serving 42k rps.' });
    await indexJob(custom);
    const vectorHits = sqliteVectorStore.search({ profileId: pid, jobId: custom, allowTailored: true, query: fakeVec('payments'), k: 10, identity: h.identity });
    expect(vectorHits.some((c) => c.sourceType === 'resume')).toBe(false);
    const mixed = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true });
    expect(mixed.some((c) => c.sourceType === 'resume')).toBe(false);
    expect(mixed.some((c) => c.content.includes('42k rps'))).toBe(true);
  });

  it('changing or clearing a role résumé invalidates its derived version and old early lookup', async () => {
    const pid = seedProfile({ resumeText: 'Payments engineer at Default Corp.' });
    await reindexProfile(pid);
    const custom = seedSpace(pid, { resumeText: 'Payments engineer at First Corp.', tailoredResume: 'Payments lead at Tailored Corp.' });
    await indexJob(custom);
    const cached = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true });
    expect(cached.some((c) => c.content.includes('Tailored Corp'))).toBe(true);
    jobsRepo.update(custom, { resumeText: 'Payments lead at Second Corp.' });
    expect(jobsRepo.get(custom)?.tailoredResume).toBeNull();
    const duringIndex = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true, cached });
    expect(duringIndex.some((c) => /First Corp|Tailored Corp|Default Corp/.test(c.content))).toBe(false);
    await indexJob(custom);
    const fresh = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true, cached });
    expect(fresh.some((c) => c.content.includes('Second Corp'))).toBe(true);
    expect(fresh.some((c) => /First Corp|Tailored Corp|Default Corp/.test(c.content))).toBe(false);
    jobsRepo.update(custom, { resumeText: null });
    await indexJob(custom);
    const reset = await retrieve(pid, 'payments', 10, custom, { tailoredResume: true, cached: fresh });
    expect(reset.some((c) => c.content.includes('Default Corp'))).toBe(true);
    expect(reset.some((c) => c.content.includes('Second Corp'))).toBe(false);
  });

  it('removing it clears the chunks on the next index', async () => {
    const pid = seedProfile();
    const space = seedSpace(pid, { tailoredResume: 'Sam — rewritten for the Staff PM role.' });
    await indexJob(space);
    expect(chunksOf(pid, 'tailored').length).toBeGreaterThan(0);

    h.db
      .update(schema.contextPacks)
      .set({ tailoredResume: null })
      .where(eq(schema.contextPacks.id, space))
      .run();
    await indexJob(space);
    expect(chunksOf(pid, 'tailored')).toHaveLength(0);
  });
});
