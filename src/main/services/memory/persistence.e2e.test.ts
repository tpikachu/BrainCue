import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Does memory ACTUALLY persist?
 *
 * memory.test.ts covers each piece in isolation — extraction gates, the review
 * lifecycle, the recall ranking. Every one of those can pass while the product
 * promise fails, because the promise spans them: *a conversation you kept last
 * week changes the answer you get today, in the Space it happened in, and
 * nowhere else.* Nothing was exercising that whole path.
 *
 * So this drives the real pipeline end to end against real persistence (sql.js
 * + the actual migrations) with only the model providers scripted:
 *
 *   session 1 → keep it → archive + candidates → approve one
 *     → session 2 in the same Space → the archive grounds it AND the memory recalls
 *
 * plus the edges where "it works" quietly stops being true: another Space,
 * another profile, consent revoked, a Space opted out, a memory still pending,
 * an expired one, an embedding-model change, a deleted Space, a discarded
 * session.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  chatJson: (async () => ({})) as (req: { system: string; user: string }) => Promise<unknown>,
  identity: { provider: 'fake', model: 'test-embed', dim: 18 },
}));

/**
 * A bag-of-words embedder over a fixed vocabulary. Deterministic, and it makes
 * "same topic" mean "shares content words" — close enough to real behaviour
 * that the cosine floor in recall.ts is genuinely exercised, rather than a
 * hand-tuned vector that would pass whatever the ranking did.
 */
const VOCAB = [
  'renewal',
  'pricing',
  'rate',
  'standup',
  'atlas',
  'migration',
  'friday',
  'deadline',
  'concise',
  'updates',
  'minute',
  'commit',
  'budget',
  'september',
  'raft',
  'consensus',
  'kubernetes',
];
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  // The trailing constant keeps cosine defined for text with no vocabulary hit.
  return Float32Array.from([...VOCAB.map((w) => (t.includes(w) ? 1 : 0)), 0.05]);
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
    if (cap === 'chat') return { json: (req: { system: string; user: string }) => h.chatJson(req) };
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
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { archiveSession } from '../engine/sessionArchive';
import { ground } from '../engine/grounding';
import { extractMemoryCandidates } from './extractor';
import { approveMemory, updateMemory } from './memoryService';
import { recallMemories } from './recall';

let seq = 0;

function seedProfile(): string {
  const id = `e2e-p${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'Test User' }).run();
  return id;
}
function seedSpace(profileId: string, title: string, over: { memoryEnabled?: number } = {}): string {
  const id = `e2e-j${++seq}`;
  h.db
    .insert(schema.contextPacks)
    .values({ id, profileId, title, kind: 'meeting', memoryEnabled: over.memoryEnabled ?? 1 })
    .run();
  return id;
}
/**
 * The Space a test conversation happens in — one per profile, reused.
 *
 * A conversation with no Space is not remembered at all (see "a Space is where
 * a conversation is kept" below), so every test about what IS remembered has to
 * run in one. Reused rather than fresh-per-call because two sessions in
 * DIFFERENT Spaces are deliberately isolated from each other, which would
 * quietly break the dedupe tests.
 */
const spaces = new Map<string, string>();
function spaceOf(profileId: string): string {
  const existing = spaces.get(profileId);
  if (existing) return existing;
  const id = seedSpace(profileId, 'Tuesday standup');
  spaces.set(profileId, id);
  return id;
}

/** A finished session with a transcript, ready to be kept. */
function seedSession(profileId: string, packId: string | null, turns: string[]): string {
  const id = `e2e-s${++seq}`;
  h.db
    .insert(schema.sessions)
    .values({
      id,
      profileId,
      packId,
      activity: 'meeting',
      mode: 'meeting',
      kind: 'live',
      status: 'stopped',
      endedAt: Date.now(),
    })
    .run();
  for (const text of turns) {
    h.db
      .insert(schema.transcriptChunks)
      .values({ id: crypto.randomUUID(), sessionId: id, speaker: 'them', text, isFinal: 1 })
      .run();
  }
  return id;
}

/** What `session:remember` does: archive the conversation and propose memories. */
async function keepSession(sessionId: string): Promise<{ archived: number; proposed: number }> {
  const [archived, proposed] = await Promise.all([
    archiveSession(sessionId),
    extractMemoryCandidates(sessionId),
  ]);
  return { archived, proposed };
}

const STANDUP_TURNS = [
  'Morning — quick standup on the Atlas migration.',
  'Phase two is blocked on the renewal pricing sign-off.',
  'Keep updates concise, under a minute each please.',
  'We commit to nothing before Friday.',
];

const ARCHIVE_REPLY = {
  topic: 'Atlas migration standup',
  summary: 'Phase two of the Atlas migration is blocked on renewal pricing sign-off.',
  participants: ['Priya'],
  keyQuotes: ['Keep updates concise, under a minute each please.'],
  sections: {
    decisions: ['Phase two waits for renewal pricing sign-off'],
    actionItems: ['Priya — chase the renewal pricing sign-off'],
    openQuestions: [],
  },
};

const EXTRACTION_REPLY = {
  candidates: [
    {
      category: 'preference',
      content: 'Priya wants standup updates concise — under a minute each.',
      scope: 'space',
      confidence: 0.9,
      importance: 0.8,
    },
  ],
};

/** One scripted responder for both model calls the pipeline makes. */
const defaultChat = async (req: { system: string; user: string }): Promise<unknown> =>
  req.system.startsWith('You write the archive entry') ? ARCHIVE_REPLY : EXTRACTION_REPLY;

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.db.delete(schema.profiles).run(); // cascades to everything below it
  spaces.clear();
  h.identity = { provider: 'fake', model: 'test-embed', dim: 18 };
  h.chatJson = defaultChat;
  settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
  settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '1');
});

// ---------------------------------------------------------------------------

describe('the loop the whole product rests on', () => {
  it('a conversation kept today changes the answer tomorrow, in the same Space', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');

    // --- Monday: a conversation happens and the user keeps it. ---
    const monday = seedSession(profileId, space, STANDUP_TURNS);
    const { archived, proposed } = await keepSession(monday);
    expect(archived).toBeGreaterThan(0);
    expect(proposed).toBe(1);

    // Proposed is not remembered: nothing is recalled before review.
    expect(await recallMemories(profileId, 'how long should updates be?', space)).toEqual([]);

    // --- The user reviews and approves. ---
    const pending = memoriesRepo.list({ profileId, status: 'pending' });
    expect(pending).toHaveLength(1);
    await approveMemory(pending[0].id);

    // --- Tuesday: the next conversation in that Space. ---
    const grounded = await ground(profileId, 'where did we land on the renewal pricing?', space);
    const archive = grounded.find((c) => c.sourceType === 'session');
    expect(archive, 'last week’s conversation must be retrievable').toBeDefined();
    expect(archive!.content).toContain('renewal pricing');

    const recalled = await recallMemories(profileId, 'how concise should updates be?', space);
    expect(recalled.map((m) => m.content)).toEqual([
      'Priya wants standup updates concise — under a minute each.',
    ]);
  });

  it('accumulates: three kept sessions leave three archives and three memories', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');

    for (let week = 0; week < 3; week++) {
      h.chatJson = async (req) =>
        req.system.startsWith('You write the archive entry')
          ? { ...ARCHIVE_REPLY, topic: `Atlas migration standup — week ${week}` }
          : {
              candidates: [
                {
                  ...EXTRACTION_REPLY.candidates[0],
                  content: `Week ${week}: the Atlas migration budget is fixed.`,
                },
              ],
            };
      const sid = seedSession(profileId, space, STANDUP_TURNS);
      await keepSession(sid);
    }

    const archives = h.db
      .select()
      .from(schema.chunks)
      .all()
      .filter((c) => c.sourceType === 'session');
    expect(new Set(archives.map((c) => c.sourceId)).size).toBe(3);
    expect(archives.every((c) => c.packId === space)).toBe(true);
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toHaveLength(3);
  });

  it('does not propose the same fact twice — a recurring Space says it every week', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');

    // Two weeks of the same standup. The extractor sees the same preference
    // stated again and proposes it again — which is correct of the extractor
    // and useless to the user, whose review queue fills with the fact they
    // already approved.
    await keepSession(seedSession(profileId, space, STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);
    await keepSession(seedSession(profileId, space, STANDUP_TURNS));

    expect(memoriesRepo.list({ profileId, status: 'pending' })).toEqual([]);
    expect(memoriesRepo.list({ profileId, status: 'approved' })).toHaveLength(1);
  });

  it('re-keeping the same session does not duplicate its memories either', async () => {
    const profileId = seedProfile();
    const sid = seedSession(profileId, spaceOf(profileId), STANDUP_TURNS);
    await keepSession(sid);
    await keepSession(sid); // the user pressed Keep twice

    expect(memoriesRepo.list({ profileId })).toHaveLength(1);
  });

  it('a profile-wide memory shadows a Space duplicate, but another Space’s does not', async () => {
    const profileId = seedProfile();
    const standup = seedSpace(profileId, 'Tuesday standup');
    const otherSpace = seedSpace(profileId, 'Acme call');
    const fact = EXTRACTION_REPLY.candidates[0].content;

    // Already known EVERYWHERE → a Space-scoped repeat is not worth asking about,
    // because the profile-wide one is already recalled inside that Space.
    const global = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'preference',
      content: fact,
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(global);
    await keepSession(seedSession(profileId, standup, STANDUP_TURNS));
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toEqual([]);

    // Known only in ANOTHER Space → that Space's conversations never see it, so
    // this Space still needs to be asked.
    memoriesRepo.delete(global);
    const elsewhere = memoriesRepo.insertCandidate({
      profileId,
      packId: otherSpace,
      category: 'preference',
      content: fact,
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(elsewhere);
    await keepSession(seedSession(profileId, standup, STANDUP_TURNS));
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toHaveLength(1);
  });

  it('a REJECTED suggestion is not raised again — the user answered it', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    memoriesRepo.setStatus(memoriesRepo.list({ profileId, status: 'pending' })[0].id, 'rejected');

    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toEqual([]);
  });

  it('matches on the words, not on punctuation or case', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    const fact = EXTRACTION_REPLY.candidates[0].content;
    h.chatJson = async (req) =>
      req.system.startsWith('You write the archive entry')
        ? ARCHIVE_REPLY
        : {
            candidates: [
              { ...EXTRACTION_REPLY.candidates[0], content: `  ${fact.toUpperCase()}!!  ` },
            ],
          };

    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(memoriesRepo.list({ profileId })).toHaveLength(1);
  });

  it('a differently-worded fact still gets through — this is not a similarity filter', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    h.chatJson = async (req) =>
      req.system.startsWith('You write the archive entry')
        ? ARCHIVE_REPLY
        : {
            candidates: [
              {
                ...EXTRACTION_REPLY.candidates[0],
                content: 'Priya keeps standup short: nobody speaks for over sixty seconds.',
              },
            ],
          };

    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(memoriesRepo.list({ profileId })).toHaveLength(2);
  });

  it('survives the SQLite round trip — a stored vector still matches its own text', async () => {
    // The whole of recall rides on a Float32Array surviving a BLOB write and
    // read. If alignment or byte length were wrong the failure would be silent:
    // memory that exists, is approved, and never scores above the floor.
    const profileId = seedProfile();
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'fact',
      content: 'The Atlas migration budget is fixed.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(id);

    const [hit] = await recallMemories(profileId, 'the Atlas migration budget', null);
    expect(hit).toBeDefined();
    expect(hit.score).toBeGreaterThan(0.9); // identical vocabulary → near-1 cosine
  });
});

// ---------------------------------------------------------------------------

describe('a Space is where a conversation is kept', () => {
  it('no Space, nothing kept — neither half leaks through', async () => {
    const profileId = seedProfile();
    const { archived, proposed } = await keepSession(
      seedSession(profileId, null, STANDUP_TURNS),
    );
    expect({ archived, proposed }).toEqual({ archived: 0, proposed: 0 });
    expect(memoriesRepo.list({ profileId })).toEqual([]);
    expect(h.db.select().from(schema.chunks).all()).toEqual([]);
  });

  it('filing it into a Space at the save prompt is what keeps it', async () => {
    // The user starts a call without a Space — most calls happen once — and it
    // turns out to belong to one. Choosing it at the end has to be worth as
    // much as choosing it at the start, so the file happens BEFORE either half
    // runs and both read their scope off it.
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');
    const sid = seedSession(profileId, null, STANDUP_TURNS);
    expect(await keepSession(sid)).toEqual({ archived: 0, proposed: 0 });

    sessionsRepo.setPack(sid, space); // what `session:remember` does first
    const { archived, proposed } = await keepSession(sid);
    expect(archived).toBeGreaterThan(0);
    expect(proposed).toBe(1);

    // And it is genuinely retrievable from inside that Space, not merely stored.
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);
    const grounded = await ground(profileId, 'where did we land on the renewal pricing?', space);
    expect(grounded.find((c) => c.sourceType === 'session')).toBeDefined();
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toHaveLength(1);
  });

  it('an unscoped conversation cannot ground a later one, in any Space', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');
    await keepSession(seedSession(profileId, null, STANDUP_TURNS));

    expect(
      (await ground(profileId, 'the renewal pricing', space)).find(
        (c) => c.sourceType === 'session',
      ),
    ).toBeUndefined();
    expect(
      (await ground(profileId, 'the renewal pricing', null)).find(
        (c) => c.sourceType === 'session',
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('a Space’s memory belongs to that Space', () => {
  it('does not leak into another Space', async () => {
    const profileId = seedProfile();
    const standup = seedSpace(profileId, 'Tuesday standup');
    const clientCall = seedSpace(profileId, 'Acme call');

    await keepSession(seedSession(profileId, standup, STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);

    // Same profile, same question, different Space: neither half follows.
    expect(await recallMemories(profileId, 'how concise should updates be?', clientCall)).toEqual(
      [],
    );
    const grounded = await ground(profileId, 'the renewal pricing', clientCall);
    expect(grounded.find((c) => c.sourceType === 'session')).toBeUndefined();
  });

  it('does not leak into another profile', async () => {
    const mine = seedProfile();
    const theirs = seedProfile();
    await keepSession(seedSession(mine, spaceOf(mine), STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId: mine, status: 'pending' })[0].id);

    expect(await recallMemories(theirs, 'how concise should updates be?', null)).toEqual([]);
    expect(memoriesRepo.list({ profileId: theirs })).toEqual([]);
  });

  it('profile-wide memory DOES reach every Space — that is what "everywhere" means', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Acme call');
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId: null, // everywhere
      category: 'preference',
      content: 'Keep updates concise.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(id);

    expect(await recallMemories(profileId, 'how concise?', space)).toHaveLength(1);
    expect(await recallMemories(profileId, 'how concise?', null)).toHaveLength(1);
  });

  it('re-scoping a memory moves where it is recalled', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Acme call');
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'preference',
      content: 'Keep updates concise.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(id);
    await updateMemory(id, { packId: space });

    expect(await recallMemories(profileId, 'how concise?', space)).toHaveLength(1);
    // No longer everywhere: an unscoped conversation stops seeing it.
    expect(await recallMemories(profileId, 'how concise?', null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('consent is a gate at every stage, not only at capture', () => {
  it('consent off: nothing is proposed and the model is never called', async () => {
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    const profileId = seedProfile();
    let called = false;
    h.chatJson = async (req) => {
      if (!req.system.startsWith('You write the archive entry')) called = true;
      return defaultChat(req);
    };
    const { proposed } = await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(proposed).toBe(0);
    expect(called).toBe(false);
  });

  it('consent revoked AFTER approval silences recall without deleting anything', async () => {
    // Turning memory off must stop it being used, not destroy what the user
    // approved — re-enabling has to bring it back intact.
    const profileId = seedProfile();
    const space = spaceOf(profileId);
    await keepSession(seedSession(profileId, space, STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toHaveLength(1);

    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
    expect(memoriesRepo.list({ profileId, status: 'approved' })).toHaveLength(1); // still there

    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toHaveLength(1);
  });

  it('a Space that opted out neither archives nor extracts', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Private 1:1', { memoryEnabled: 0 });
    const { archived, proposed } = await keepSession(seedSession(profileId, space, STANDUP_TURNS));
    expect({ archived, proposed }).toEqual({ archived: 0, proposed: 0 });
  });

  it('the two switches are INDEPENDENT — archiving off still proposes memories', async () => {
    // They are different promises: one summarises a conversation, the other
    // extracts standing claims about the person. Wiring one to the other would
    // make turning off summaries silently disable memory too.
    settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '0');
    const profileId = seedProfile();
    const { archived, proposed } = await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(archived).toBe(0);
    expect(proposed).toBe(1);
  });

  it('…and memory off still archives', async () => {
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    const profileId = seedProfile();
    const { archived, proposed } = await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(archived).toBeGreaterThan(0);
    expect(proposed).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('only what the user approved is ever used', () => {
  const approvedContent = 'Priya wants standup updates concise — under a minute each.';

  async function seedOneCandidate(): Promise<{ profileId: string; id: string; space: string }> {
    const profileId = seedProfile();
    const space = spaceOf(profileId);
    await keepSession(seedSession(profileId, space, STANDUP_TURNS));
    return { profileId, id: memoriesRepo.list({ profileId, status: 'pending' })[0].id, space };
  }

  it('pending is never recalled', async () => {
    const { profileId, space } = await seedOneCandidate();
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
  });

  it('…and would still not be, even if it somehow carried a vector', async () => {
    // A pending row normally has no embedding, so the status gate and the
    // has-a-vector gate agree and either alone would pass this suite. Forcing a
    // vector onto a pending row separates them: `status = 'approved'` is what
    // makes a memory usable, and nothing else may stand in for it.
    const { profileId, id, space } = await seedOneCandidate();
    await approveMemory(id);
    memoriesRepo.setStatus(id, 'pending'); // keeps the embedding, drops the approval
    expect(memoriesRepo.get(id)?.status).toBe('pending');

    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
  });

  it('rejected is never recalled', async () => {
    const { profileId, id, space } = await seedOneCandidate();
    memoriesRepo.setStatus(id, 'rejected');
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
  });

  it('archiving an approved memory takes it out of recall but keeps the row', async () => {
    const { profileId, id, space } = await seedOneCandidate();
    await approveMemory(id);
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toHaveLength(1);

    memoriesRepo.setStatus(id, 'archived');
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
    expect(memoriesRepo.get(id)).not.toBeNull();
  });

  it('an edit at approval time is what gets remembered', async () => {
    const { profileId, id, space } = await seedOneCandidate();
    await approveMemory(id, { content: 'Standup updates stay under a minute — Priya is strict.' });
    const [hit] = await recallMemories(profileId, 'how long can a standup update be?', space);
    expect(hit.content).toBe('Standup updates stay under a minute — Priya is strict.');
    expect(hit.content).not.toBe(approvedContent);
  });

  it('editing the content re-embeds, so recall follows the new words', async () => {
    // The stale-vector bug: content updated, embedding not. The memory would
    // keep matching what it USED to say — invisible until the wrong thing
    // surfaces in a call.
    const { profileId, id, space } = await seedOneCandidate();
    await approveMemory(id);
    await updateMemory(id, { content: 'The Raft consensus paper is the reference for phase two.' });

    expect(await recallMemories(profileId, 'raft consensus', space)).toHaveLength(1);
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
  });

  it('deleting removes the memory AND its vector together', async () => {
    const { profileId, id, space } = await seedOneCandidate();
    await approveMemory(id);
    memoriesRepo.delete(id);

    expect(memoriesRepo.get(id)).toBeNull();
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toEqual([]);
    // The embedding lives ON the row, so nothing can be orphaned.
    expect(h.db.select().from(schema.memories).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('memory that should no longer apply', () => {
  it('an expired memory is not recalled', async () => {
    const profileId = seedProfile();
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'fact',
      content: 'The Atlas migration budget is fixed until September.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(id);
    await updateMemory(id, { expiresAt: Date.now() - 1000 });

    expect(await recallMemories(profileId, 'the Atlas migration budget', null)).toEqual([]);
  });

  it('a memory embedded by a DIFFERENT model waits for a re-embed instead of mis-ranking', async () => {
    const profileId = seedProfile();
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'fact',
      content: 'The Atlas migration budget is fixed.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(id);
    expect(await recallMemories(profileId, 'the Atlas migration budget', null)).toHaveLength(1);

    // The user switched embedding models. Old vectors are not comparable.
    h.identity = { provider: 'fake', model: 'test-embed-v2', dim: 18 };
    expect(await recallMemories(profileId, 'the Atlas migration budget', null)).toEqual([]);
  });

  it('an unrelated question recalls nothing — the floor is a real gate', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);

    expect(await recallMemories(profileId, 'what is the kubernetes rollout plan?', null)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------

describe('deleting the thing memory hung off', () => {
  it('discarding a session removes its archive and its PENDING candidates only', async () => {
    const profileId = seedProfile();
    const space = seedSpace(profileId, 'Tuesday standup');

    // One session whose memory was approved, one still pending.
    const kept = seedSession(profileId, space, STANDUP_TURNS);
    await keepSession(kept);
    const approvedId = memoriesRepo.list({ profileId, status: 'pending' })[0].id;
    await approveMemory(approvedId);

    // A second session proposing something GENUINELY new (a repeat of the
    // first would now be suppressed as already-known).
    h.chatJson = async (req) =>
      req.system.startsWith('You write the archive entry')
        ? ARCHIVE_REPLY
        : {
            candidates: [
              {
                ...EXTRACTION_REPLY.candidates[0],
                content: 'The Atlas migration budget is fixed through September.',
              },
            ],
          };
    const discarded = seedSession(profileId, space, STANDUP_TURNS);
    await keepSession(discarded);
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toHaveLength(1);

    memoriesRepo.deleteBySession(discarded);
    sessionsRepo.delete(discarded);

    // The discarded session's suggestion is gone…
    expect(memoriesRepo.list({ profileId, status: 'pending' })).toEqual([]);
    // …its archive with it…
    const archives = h.db
      .select()
      .from(schema.chunks)
      .all()
      .filter((c) => c.sourceType === 'session');
    expect(archives.every((c) => c.sourceId === kept)).toBe(true);
    // …and the memory the user already approved is untouched.
    expect(memoriesRepo.get(approvedId)?.status).toBe('approved');
    expect(await recallMemories(profileId, 'how concise should updates be?', space)).toHaveLength(1);
  });

  it('deleting a Space takes its memory with it and leaves the rest alone', async () => {
    const profileId = seedProfile();
    const doomed = seedSpace(profileId, 'Old client');
    const kept = seedSpace(profileId, 'Tuesday standup');

    const scoped = memoriesRepo.insertCandidate({
      profileId,
      packId: doomed,
      category: 'fact',
      content: 'Their renewal rate is fixed.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    const global = memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'preference',
      content: 'Keep updates concise.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await approveMemory(scoped);
    await approveMemory(global);

    contextPacksRepo.delete(doomed);

    // The Space is gone, so memory that only made sense inside it goes too —
    // otherwise it would linger, unreachable, attached to nothing.
    expect(memoriesRepo.get(scoped)).toBeNull();
    expect(memoriesRepo.get(global)).not.toBeNull();
    expect(await recallMemories(profileId, 'how concise?', kept)).toHaveLength(1);
  });

  it('deleting a profile takes everything it owned', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, seedSpace(profileId, 'Standup'), STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);

    h.db.delete(schema.profiles).run();

    expect(h.db.select().from(schema.memories).all()).toEqual([]);
    expect(h.db.select().from(schema.sessions).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('nothing here may break a live answer', () => {
  it('a failing extractor still lets the archive through', async () => {
    const profileId = seedProfile();
    h.chatJson = async (req) => {
      if (req.system.startsWith('You write the archive entry')) return ARCHIVE_REPLY;
      throw new Error('extraction provider exploded');
    };
    const { archived, proposed } = await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    expect(archived).toBeGreaterThan(0);
    expect(proposed).toBe(0);
  });

  it('a failing embedder makes recall empty, never a thrown error', async () => {
    const profileId = seedProfile();
    await keepSession(seedSession(profileId, spaceOf(profileId), STANDUP_TURNS));
    await approveMemory(memoriesRepo.list({ profileId, status: 'pending' })[0].id);

    const identity = h.identity;
    h.identity = null as unknown as typeof identity; // provider.identity() now throws
    await expect(recallMemories(profileId, 'how concise?', null)).resolves.toEqual([]);
  });

  it('a session with nothing in it produces neither an archive nor a memory', async () => {
    const profileId = seedProfile();
    const { archived, proposed } = await keepSession(seedSession(profileId, spaceOf(profileId), []));
    expect({ archived, proposed }).toEqual({ archived: 0, proposed: 0 });
  });
});
