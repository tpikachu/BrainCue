import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Conversation continuity (docs/16-CONTINUITY.md) against REAL persistence
 * (sql.js + drizzle migrations) with a scripted provider registry: a finished
 * session becomes a retrievable archive, an archive never outlives its session,
 * and archives can never crowd the corpus out of grounding.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  chatJson: (async () => ({})) as (req: { system: string; user: string }) => Promise<unknown>,
  chatCalls: 0,
  identity: { provider: 'fake', model: 'test-embed', dim: 4 },
}));

/** Deterministic topic embedding: dim0 = renewal/pricing, dim1 = migration,
 *  dim2 = résumé/experience; a small shared component keeps cosine defined. */
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  return Float32Array.from([
    t.includes('renewal') || t.includes('pricing') ? 1 : 0,
    t.includes('migration') || t.includes('atlas') ? 1 : 0,
    t.includes('résumé') || t.includes('resume') || t.includes('experience') ? 1 : 0,
    0.05,
  ]);
}

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
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'chat') {
      return {
        json: (req: { system: string; user: string }) => {
          h.chatCalls += 1;
          return h.chatJson(req);
        },
      };
    }
    if (cap === 'embedding') {
      return {
        identity: () => h.identity,
        embed: async (texts: string[]) => texts.map(fakeVec),
        embedOne: async (text: string) => fakeVec(text),
      };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { archiveSession, renderArchive } from './sessionArchive';
import { SESSION_ARCHIVE_MAX, capSource, retrieve } from '../rag/retriever';
import { ground } from './grounding';
import type { RetrievedChunk } from '@shared/types';

let seq = 0;

function seedProfile(): string {
  const id = `arc-p${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'A', targetRole: 'PM' }).run();
  return id;
}
function seedPack(profileId: string, memoryEnabled = 1): string {
  const id = `arc-j${++seq}`;
  h.db
    .insert(schema.contextPacks)
    .values({ id, profileId, title: `Pack ${id}`, memoryEnabled })
    .run();
  return id;
}
function seedSession(
  profileId: string,
  packId: string | null,
  turns: string[],
  over: Partial<typeof schema.sessions.$inferInsert> = {},
): string {
  const id = `arc-s${++seq}`;
  h.db
    .insert(schema.sessions)
    .values({
      id,
      profileId,
      packId,
      mode: 'meeting',
      kind: 'live',
      interviewType: 'general',
      status: 'stopped',
      ...over,
    })
    .run();
  for (const t of turns) {
    h.db
      .insert(schema.transcriptChunks)
      .values({ id: crypto.randomUUID(), sessionId: id, speaker: 'them', text: t, isFinal: 1 })
      .run();
  }
  return id;
}
/** A non-session chunk, so retrieval has real corpus to compete with. */
function seedChunk(profileId: string, content: string, sourceType = 'resume'): string {
  const id = `arc-c${++seq}`;
  const vec = fakeVec(content);
  h.db
    .insert(schema.chunks)
    .values({ id, profileId, packId: null, sourceType, sourceId: null, ord: 0, content })
    .run();
  h.db
    .insert(schema.embeddings)
    .values({
      id: crypto.randomUUID(),
      chunkId: id,
      provider: h.identity.provider,
      model: h.identity.model,
      dim: h.identity.dim,
      vector: Buffer.from(vec.buffer.slice(0)),
    })
    .run();
  return id;
}
const archiveChunks = (profileId: string) =>
  h.db
    .select()
    .from(schema.chunks)
    .all()
    .filter((c) => c.profileId === profileId && c.sourceType === 'session');

const FOUR_TURNS = [
  'Thanks for making time — we wanted to talk about the renewal.',
  'Right, the current pricing runs out at the end of the quarter.',
  'We can hold the current rate if you commit to two years.',
  'Let me take that back to the team and confirm by Friday.',
];

const GOOD_ARCHIVE = {
  topic: 'Acme renewal pricing',
  summary: 'Acme discussed renewal terms; the current rate holds for a two-year commitment.',
  decisions: ['Hold the current rate for a two-year term'],
  actionItems: ['Sarah Chen — confirm the two-year commitment by Friday'],
  openQuestions: [],
  participants: ['Acme', 'Sarah Chen'],
};

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.chatCalls = 0;
  h.chatJson = async () => GOOD_ARCHIVE;
  settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '1');
});

describe('archiving a finished conversation', () => {
  it('writes a retrievable archive scoped to where the conversation happened', async () => {
    const pid = seedProfile();
    const packId = seedPack(pid);
    const sid = seedSession(pid, packId, FOUR_TURNS);

    expect(await archiveSession(sid)).toBeGreaterThan(0);

    const rows = archiveChunks(pid);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sourceId === sid)).toBe(true);
    // Scoped to the Space, so one client's history can never ground another's.
    expect(rows.every((r) => r.packId === packId)).toBe(true);
    expect(rows.map((r) => r.content).join(' ')).toContain('renewal');
    // Every chunk is embedded — an un-embedded archive is invisible to recall.
    const ids = new Set(rows.map((r) => r.id));
    const vectors = h.db
      .select()
      .from(schema.embeddings)
      .all()
      .filter((e) => ids.has(e.chunkId));
    expect(vectors).toHaveLength(rows.length);
  });

  it('grounds a LATER conversation in the earlier one', async () => {
    const pid = seedProfile();
    seedChunk(pid, 'Ten years of experience leading platform teams.'); // corpus to compete with
    const sid = seedSession(pid, null, FOUR_TURNS); // unscoped → follows the user
    await archiveSession(sid);

    const hits = await retrieve(pid, 'where did we land on the renewal pricing?', 5, null);
    const archive = hits.find((c) => c.sourceType === 'session');
    expect(archive).toBeDefined();
    expect(archive!.content).toContain('two-year');
  });

  it('does not archive before the conversation is one', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, null, ['Hi.', 'Hello.']); // below MIN_TURNS
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0); // and nothing is sent anywhere
  });

  it('respects the global switch', async () => {
    settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '0');
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('respects a Space that opted out of remembering', async () => {
    const pid = seedProfile();
    const packId = seedPack(pid, 0);
    const sid = seedSession(pid, packId, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('never archives a practice drill — a rehearsal is not something that happened', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS, { mode: 'practice', kind: 'sparring' });
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('refuses to index an archive the sensitive filter flags', async () => {
    const pid = seedProfile();
    h.chatJson = async () => ({
      ...GOOD_ARCHIVE,
      summary: 'They read out the staging password, which is hunter2, during the call.',
    });
    const sid = seedSession(pid, null, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('writes nothing when the summariser returns an unusable shape', async () => {
    const pid = seedProfile();
    h.chatJson = async () => ({ topic: 'x' }); // fails the schema
    const sid = seedSession(pid, null, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('re-archiving replaces rather than duplicating', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS);
    const first = await archiveSession(sid);
    const again = await archiveSession(sid);
    expect(again).toBe(first);
    expect(archiveChunks(pid)).toHaveLength(first);
  });

  it('renders the pieces as one coherent block — an action item alone is not context', () => {
    const text = renderArchive(GOOD_ARCHIVE, Date.parse('2026-07-28T10:00:00Z'));
    expect(text).toContain('2026-07-28');
    expect(text).toContain('Acme renewal pricing');
    expect(text).toContain('Sarah Chen — confirm');
    expect(text).not.toContain('Still open'); // empty sections are omitted
  });
});

describe('an archive never outlives its session', () => {
  it('deleting a session deletes its archive and the vector with it', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS);
    await archiveSession(sid);
    const ids = archiveChunks(pid).map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);

    sessionsRepo.delete(sid);

    expect(archiveChunks(pid)).toHaveLength(0);
    const orphans = h.db
      .select()
      .from(schema.embeddings)
      .all()
      .filter((e) => ids.includes(e.chunkId));
    expect(orphans).toHaveLength(0);
  });

  it('deleting every session clears every archive', async () => {
    const pid = seedProfile();
    await archiveSession(seedSession(pid, null, FOUR_TURNS));
    expect(archiveChunks(pid).length).toBeGreaterThan(0);

    sessionsRepo.deleteAll();

    expect(archiveChunks(pid)).toHaveLength(0);
  });
});

describe('the STAR story cue belongs to interviews only', () => {
  /**
   * The fixture has to isolate FORCE-inclusion from ordinary ranking, or it
   * proves nothing: a story that wins the top-k on cosine appears under every
   * mode and always would. So the story here scores ~0.71 against the query —
   * above STORY_CUE_MIN_SCORE (0.3), and below six notes that score 1.0 and
   * fill every one of the k=5 slots. It can therefore ONLY appear via the
   * force path.
   */
  function seedStoryBelowTopK(pid: string): void {
    seedChunk(pid, 'Renewal experience: I led the Acme renegotiation.', 'story');
    for (let i = 0; i < 6; i += 1) seedChunk(pid, `Renewal pricing note ${i}.`, 'note');
  }

  it('interview mode force-includes it', async () => {
    const pid = seedProfile();
    seedStoryBelowTopK(pid);
    const hits = await ground(pid, 'renewal pricing', null, 'interview');
    expect(hits.some((c) => c.sourceType === 'story')).toBe(true);
  });

  it('a meeting does not — a résumé anecdote is not context for a client call', async () => {
    const pid = seedProfile();
    seedStoryBelowTopK(pid);
    const hits = await ground(pid, 'renewal pricing', null, 'meeting');
    expect(hits.some((c) => c.sourceType === 'story')).toBe(false);
  });

  it('nor does the companion', async () => {
    const pid = seedProfile();
    seedStoryBelowTopK(pid);
    const hits = await ground(pid, 'renewal pricing', null, 'companion');
    expect(hits.some((c) => c.sourceType === 'story')).toBe(false);
  });
});

describe('archives cannot crowd the corpus out of grounding', () => {
  const chunk = (id: string, sourceType: string, score: number): RetrievedChunk =>
    ({ id, sourceType, content: id, score }) as RetrievedChunk;

  it('caps how many of the top-k slots archives may take', () => {
    // Every archive outranks every document — the state a user reaches after
    // enough calls, and the one where an uncapped ranking returns no corpus.
    const ranked = [
      chunk('a1', 'session', 0.99),
      chunk('a2', 'session', 0.98),
      chunk('a3', 'session', 0.97),
      chunk('a4', 'session', 0.96),
      chunk('r1', 'resume', 0.5),
      chunk('r2', 'note', 0.4),
    ];
    const out = capSource(ranked, 'session', SESSION_ARCHIVE_MAX, 5);
    expect(out.filter((c) => c.sourceType === 'session')).toHaveLength(SESSION_ARCHIVE_MAX);
    // The freed slots go to real alternatives, not to nothing.
    expect(out.map((c) => c.id)).toEqual(['a1', 'a2', 'r1', 'r2']);
  });

  it('leaves a normal result set untouched', () => {
    const ranked = [
      chunk('r1', 'resume', 0.9),
      chunk('a1', 'session', 0.8),
      chunk('r2', 'note', 0.7),
    ];
    expect(capSource(ranked, 'session', SESSION_ARCHIVE_MAX, 5).map((c) => c.id)).toEqual([
      'r1',
      'a1',
      'r2',
    ]);
  });

  it('holds end-to-end: many archives still leave room for the résumé', async () => {
    const pid = seedProfile();
    seedChunk(pid, 'Ten years of experience leading platform teams.');
    // Six archived calls, all closer to the query than the résumé is.
    for (let i = 0; i < 6; i += 1) {
      await archiveSession(seedSession(pid, null, FOUR_TURNS));
    }
    expect(archiveChunks(pid).length).toBeGreaterThan(SESSION_ARCHIVE_MAX);

    const hits = await retrieve(pid, 'renewal pricing', 5, null);
    expect(hits.filter((c) => c.sourceType === 'session').length).toBeLessThanOrEqual(
      SESSION_ARCHIVE_MAX,
    );
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(true);
  });
});
