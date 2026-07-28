import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a profile re-index owns — and what it must leave alone.
 *
 * `reindexProfile` clears every unscoped chunk for the profile before writing
 * fresh ones. That set has grown twice: STAR stories are managed separately,
 * and conversation archives (docs/16-CONTINUITY.md) are unscoped when the
 * session had no Space. Without an explicit exclusion, editing your name would
 * silently erase every memory of every call you have ever had — a data-loss bug
 * with no error and no symptom until an answer quietly stops citing last week.
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

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { reindexProfile } from './indexProfile';
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
