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
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import {
  archiveSession,
  attributeQuotes,
  buildSystem,
  renderArchive,
  takeSections,
} from './sessionArchive';
import { ARCHIVE_FORMATS, archiveFormat } from '@shared/archiveFormat';
import { ACTIVITY_ORDER } from '@shared/activities';
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
/**
 * The Space a test conversation happened in — one per profile, reused.
 *
 * A conversation with no Space is not archived at all (see "a conversation with
 * no Space is not kept" below), so every test about what IS archived has to run
 * in one.
 */
const packs = new Map<string, string>();
function packOf(profileId: string): string {
  const existing = packs.get(profileId);
  if (existing) return existing;
  const id = seedPack(profileId);
  packs.set(profileId, id);
  return id;
}
function seedSession(
  profileId: string,
  packId: string | null,
  turns: (string | { speaker: string; text: string })[],
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
    const turn = typeof t === 'string' ? { speaker: 'them', text: t } : t;
    h.db
      .insert(schema.transcriptChunks)
      .values({ id: crypto.randomUUID(), sessionId: id, ...turn, isFinal: 1 })
      .run();
  }
  return id;
}
/** A non-session chunk, so retrieval has real corpus to compete with. */
function seedChunk(
  profileId: string,
  content: string,
  sourceType = 'resume',
  packId: string | null = null,
): string {
  const id = `arc-c${++seq}`;
  const vec = fakeVec(content);
  h.db
    .insert(schema.chunks)
    .values({ id, profileId, packId, sourceType, sourceId: null, ord: 0, content })
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
  participants: ['Acme', 'Sarah Chen'],
  keyQuotes: ['We can hold the current rate if you commit to two years.'],
  sections: {
    decisions: ['Hold the current rate for a two-year term'],
    actionItems: ['Sarah Chen — confirm the two-year commitment by Friday'],
    openQuestions: [],
  },
};

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  packs.clear();
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
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    await archiveSession(sid);

    // Retrieved from inside the Space it happened in — the only place it is.
    const hits = await retrieve(pid, 'where did we land on the renewal pricing?', 5, packOf(pid));
    const archive = hits.find((c) => c.sourceType === 'session');
    expect(archive).toBeDefined();
    expect(archive!.content).toContain('two-year');
  });

  it('does not archive before the conversation is one', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), ['Hi.', 'Hello.']); // below MIN_TURNS
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0); // and nothing is sent anywhere
  });

  it('respects the global switch', async () => {
    settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '0');
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('a conversation with no Space is not kept — there is nowhere to keep it', async () => {
    // An archive has to be scoped to something to be worth retrieving: the
    // Space is what makes the tenth standup grounded in the previous nine, and
    // what stops one client's history grounding another client's call. Without
    // one the session helped live and leaves its transcript, nothing more.
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0); // and the transcript is never sent anywhere
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('…and is kept the moment it is filed into one', async () => {
    // What the save prompt does: a call started without a Space often turns out
    // to belong to one, and filing it is what makes that choice mean something.
    const pid = seedProfile();
    const sid = seedSession(pid, null, FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);

    sessionsRepo.setPack(sid, packOf(pid));
    expect(await archiveSession(sid)).toBeGreaterThan(0);
    expect(archiveChunks(pid).every((c) => c.packId === packOf(pid))).toBe(true);
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
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS, { mode: 'practice', kind: 'sparring' });
    expect(await archiveSession(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('refuses to index an archive the sensitive filter flags', async () => {
    const pid = seedProfile();
    h.chatJson = async () => ({
      ...GOOD_ARCHIVE,
      summary: 'They read out the staging password, which is hunter2, during the call.',
    });
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('writes nothing when the summariser returns an unusable shape', async () => {
    const pid = seedProfile();
    h.chatJson = async () => ({ topic: 'x' }); // fails the schema
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    expect(await archiveSession(sid)).toBe(0);
    expect(archiveChunks(pid)).toHaveLength(0);
  });

  it('re-archiving replaces rather than duplicating', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    const first = await archiveSession(sid);
    const again = await archiveSession(sid);
    expect(again).toBe(first);
    expect(archiveChunks(pid)).toHaveLength(first);
  });

  it('renders the pieces as one coherent block — an action item alone is not context', () => {
    const text = renderArchive(GOOD_ARCHIVE, Date.parse('2026-07-28T10:00:00Z'), {
      format: archiveFormat('meeting'),
    });
    expect(text).toContain('2026-07-28');
    expect(text).toContain('Acme renewal pricing');
    expect(text).toContain('Sarah Chen — confirm');
    expect(text).not.toContain('Still open'); // empty sections are omitted
  });
});

/**
 * A Space accumulates: its documents are where it starts, and every kept
 * session adds an archive, so the tenth standup is grounded in the previous
 * nine. That only works if the entries are COMPARABLE — "Decided:" has to mean
 * the same thing in every entry for that Space. And the things worth carrying
 * forward differ by activity: forcing one shape on all of them either invents
 * decisions in a tutorial or throws away the questions from an interview.
 */
describe('the archive format is fixed per activity', () => {
  it('gives every activity a format, with unique keys and real guidance', () => {
    for (const kind of ACTIVITY_ORDER) {
      const format = ARCHIVE_FORMATS[kind];
      expect(format.length, kind).toBeGreaterThan(0);
      expect(new Set(format.map((f) => f.key)).size, kind).toBe(format.length);
      for (const s of format) {
        expect(s.label.length, `${kind}.${s.key}`).toBeGreaterThan(0);
        expect(s.guidance.length, `${kind}.${s.key}`).toBeGreaterThan(10);
        expect(s.max, `${kind}.${s.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('records what an interview leaves behind, not what a standup does', () => {
    const job = ARCHIVE_FORMATS.job.map((f) => f.key);
    expect(job).toContain('questionsAsked');
    expect(job).toContain('claims');
    // "Action items" is a meeting's residue; an interview's is what was asked.
    expect(job).not.toContain('actionItems');
  });

  it('records what a study session leaves behind', () => {
    const subject = ARCHIVE_FORMATS.subject.map((f) => f.key);
    expect(subject).toContain('covered');
    expect(subject).toContain('struggled'); // the point of coming back
    expect(subject).not.toContain('decisions');
  });

  it('falls back to the conversation shape for an unknown activity', () => {
    // v1 rows have no activity at all, and are still conversations.
    expect(archiveFormat(null)).toBe(ARCHIVE_FORMATS.custom);
    expect(archiveFormat('not-a-kind')).toBe(ARCHIVE_FORMATS.custom);
    expect(archiveFormat('subject')).toBe(ARCHIVE_FORMATS.subject);
  });

  it('asks the summariser for exactly the keys it will keep', () => {
    // The prompt is built from the format, so the keys requested and the keys
    // kept cannot drift — the failure mode is silent, empty sections.
    for (const kind of ACTIVITY_ORDER) {
      const format = ARCHIVE_FORMATS[kind];
      const system = buildSystem(format);
      for (const s of format) expect(system, `${kind}.${s.key}`).toContain(`"${s.key}"`);
    }
    // And it does not offer another activity's keys.
    expect(buildSystem(ARCHIVE_FORMATS.subject)).not.toContain('actionItems');
  });
});

describe('archiveSession reads the format off the SESSION', () => {
  // The table above proves each activity HAS a format; it cannot prove the
  // archive uses the right one. A constant here would leave every standup and
  // every interview archived identically — silently, and only visible weeks
  // later when retrieval brings back the wrong shape.
  it('archives a study session under the study headings', async () => {
    const pid = seedProfile();
    let asked = '';
    h.chatJson = async (req) => {
      asked = req.system;
      return {
        topic: 'Consensus protocols',
        summary: 'Worked through Raft leader election end to end.',
        participants: [],
        keyQuotes: [],
        sections: {
          covered: ['Raft leader election'],
          struggled: ['why terms increase'],
          actionItems: ['book a follow-up'], // not a section this activity has
        },
      };
    };
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS, { activity: 'subject' });
    await archiveSession(sid);

    const text = archiveChunks(pid)
      .map((c) => c.content)
      .join('\n');
    expect(text).toContain('Covered:');
    expect(text).toContain('Did not land:');
    expect(text).not.toContain('Action items:');
    // …and the summariser was asked for the study keys, not the meeting ones.
    expect(asked).toContain('"struggled"');
    expect(asked).not.toContain('"actionItems"');
  });

  it('falls back to the Space’s kind when the session predates activities', async () => {
    const pid = seedProfile();
    const packId = `arc-jobpack${++seq}`;
    h.db
      .insert(schema.contextPacks)
      .values({ id: packId, profileId: pid, title: 'Acme — Senior PM', kind: 'job' })
      .run();
    let asked = '';
    h.chatJson = async (req) => {
      asked = req.system;
      return { ...GOOD_ARCHIVE, sections: { questionsAsked: ['why this role?'] } };
    };
    const sid = seedSession(pid, packId, FOUR_TURNS); // no activity column value
    await archiveSession(sid);

    expect(asked).toContain('"questionsAsked"');
    expect(archiveChunks(pid).map((c) => c.content).join('\n')).toContain('They asked:');
  });
});

describe('takeSections — what the model returns is not what gets stored', () => {
  const format = ARCHIVE_FORMATS.meeting;

  it('keeps the declared keys, in the declared order', () => {
    // The model returned them backwards; the archive reads the same either way.
    const out = takeSections(format, {
      openQuestions: ['who owns rollout?'],
      decisions: ['ship on the 12th'],
    });
    expect(out.map((o) => o.section.key)).toEqual(['decisions', 'openQuestions']);
  });

  it('DROPS a key this activity did not declare', () => {
    // An interview archive must not grow "Action items" because the summariser
    // is in the habit of writing one.
    const out = takeSections(ARCHIVE_FORMATS.job, {
      questionsAsked: ['why this role?'],
      actionItems: ['send a thank-you note'],
    });
    expect(out.map((o) => o.section.key)).toEqual(['questionsAsked']);
  });

  it('caps a section at its declared max', () => {
    const items = Array.from({ length: 30 }, (_, i) => `decision ${i}`);
    const out = takeSections(format, { decisions: items });
    expect(out[0].items).toHaveLength(8);
  });

  it('omits an empty section rather than printing an empty heading', () => {
    expect(takeSections(format, { decisions: [], actionItems: ['   '] })).toEqual([]);
  });

  it('renders each activity under its own headings', () => {
    const archive = {
      topic: 'Consensus protocols',
      summary: 'Worked through Raft leader election.',
      participants: [],
      keyQuotes: [],
      sections: { covered: ['Raft leader election'], struggled: ['why terms increase'] },
    };
    const text = renderArchive(archive, Date.parse('2026-07-28T10:00:00Z'), {
      format: archiveFormat('subject'),
    });
    expect(text).toContain('Covered: Raft leader election.');
    expect(text).toContain('Did not land: why terms increase.');
    expect(text).not.toContain('Decided');
  });
});

/**
 * A summary says what a call was about. Quoting it says what was SAID — the
 * difference between "we discussed pricing" and being able to answer "what
 * exactly did they offer?" three calls later. That is only worth having if a
 * quote can be trusted, so nothing the model returns is taken on faith.
 */
describe('the words themselves', () => {
  const TURNS = [
    { speaker: 'them', text: 'We can hold the current rate if you commit to two years.' },
    { speaker: 'you', text: 'Let me take that back to the team and confirm by Friday.' },
  ];

  it('keeps a line that was said', () => {
    expect(attributeQuotes(['We can hold the current rate if you commit to two years.'], TURNS))
      .toEqual([
        { speaker: 'They', text: 'We can hold the current rate if you commit to two years.' },
      ]);
  });

  it('DROPS a line that was not — a fabricated quote is worse than no quote', () => {
    expect(attributeQuotes(['We can hold the current rate indefinitely.'], TURNS)).toEqual([]);
    // Including a plausible paraphrase of something that WAS said.
    expect(attributeQuotes(['They offered to hold the rate for two years.'], TURNS)).toEqual([]);
  });

  it('attributes from the transcript row, never from the model', () => {
    // Both quotes are real; they were said by different people. Attribution is
    // looked up, so the model cannot put words in the wrong mouth.
    const out = attributeQuotes(
      ['Let me take that back to the team', 'We can hold the current rate'],
      TURNS,
    );
    expect(out.map((q) => q.speaker)).toEqual(['You', 'They']);
  });

  it('matches on the words, not on whitespace or case', () => {
    expect(attributeQuotes(['  we can HOLD the current   rate  '], TURNS)).toHaveLength(1);
  });

  it('passes an unrecognised speaker label through rather than flattening it', () => {
    // Diarisation would put a real name here; it must survive unchanged.
    const out = attributeQuotes(['Hello there'], [{ speaker: 'Priya', text: 'Hello there.' }]);
    expect(out[0].speaker).toBe('Priya');
  });

  it('never repeats the same line twice', () => {
    const out = attributeQuotes(
      ['We can hold the current rate', 'we can hold THE CURRENT rate'],
      TURNS,
    );
    expect(out).toHaveLength(1);
  });

  it('indexes the verified quote, attributed, into the archive', async () => {
    const pid = seedProfile();
    h.chatJson = async () => ({
      ...GOOD_ARCHIVE,
      keyQuotes: [
        'We can hold the current rate if you commit to two years.', // real
        'And we will throw in onboarding for free.', // never said
      ],
    });
    const sid = seedSession(pid, packOf(pid), [
      ...FOUR_TURNS.slice(0, 3),
      { speaker: 'you', text: FOUR_TURNS[3] },
    ]);
    await archiveSession(sid);

    const text = archiveChunks(pid)
      .map((c) => c.content)
      .join('\n');
    expect(text).toContain('They: “We can hold the current rate if you commit to two years.”');
    expect(text).not.toContain('onboarding for free');
  });
});

describe('an archive never outlives its session', () => {
  it('deleting a session deletes its archive and the vector with it', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
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
    await archiveSession(seedSession(pid, packOf(pid), FOUR_TURNS));
    expect(archiveChunks(pid).length).toBeGreaterThan(0);

    sessionsRepo.deleteAll();

    expect(archiveChunks(pid)).toHaveLength(0);
  });
});

describe('discarding a conversation leaves nothing behind', () => {
  const seedMemory = (
    profileId: string,
    sessionId: string | null,
    status: 'pending' | 'approved',
  ) => {
    const id = `arc-m${++seq}`;
    h.db
      .insert(schema.memories)
      .values({
        id,
        profileId,
        category: 'fact',
        content: `memory ${id}`,
        status,
        confidence: 0.9,
        importance: 0.5,
        sourceRefs: sessionId ? JSON.stringify([{ type: 'session', id: sessionId }]) : null,
      })
      .run();
    return id;
  };
  const statusOf = (id: string) =>
    h.db
      .select()
      .from(schema.memories)
      .all()
      .find((m) => m.id === id)?.status ?? null;

  it('deletes the candidates it suggested', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    const mine = seedMemory(pid, sid, 'pending');
    const other = seedMemory(pid, `arc-other${++seq}`, 'pending');

    expect(memoriesRepo.deleteBySession(sid)).toBe(1);
    expect(statusOf(mine)).toBeNull();
    expect(statusOf(other)).toBe('pending'); // another session's queue is untouched
  });

  it('keeps memories the user already approved — that decision was theirs', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    const approved = seedMemory(pid, sid, 'approved');

    memoriesRepo.deleteBySession(sid);

    // They read it, said yes, possibly edited it. Discarding the conversation
    // it came from must not take that back.
    expect(statusOf(approved)).toBe('approved');
  });

  it('ignores memories with no provenance rather than guessing', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, packOf(pid), FOUR_TURNS);
    const orphan = seedMemory(pid, null, 'pending');
    memoriesRepo.deleteBySession(sid);
    expect(statusOf(orphan)).toBe('pending');
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

/**
 * The same rule for the TAILORED résumé, which had no such rule at all.
 *
 * A tailored résumé is the user's CV rewritten for ONE job application, and
 * retrieval SUPPRESSES the real résumé wherever it applies. That substitution
 * ran in every mode, so a single leftover application silently replaced the
 * user's actual experience in unrelated meetings — the model was told they are
 * whoever they described themselves as for a job they applied to once.
 *
 * The fixture makes suppression the only possible explanation: both chunks
 * match the query, so if the base résumé is missing it was filtered, not
 * out-ranked.
 */
describe('a tailored résumé belongs to its own application only', () => {
  function seedBaseAndTailored(pid: string): string {
    const pack = packOf(pid);
    seedChunk(pid, 'Renewal pricing: ten years leading platform teams.', 'resume');
    seedChunk(pid, 'Renewal pricing: rewritten for the Acme role.', 'tailored', pack);
    return pack;
  }

  it('substitutes for the base résumé while grounding that interview', async () => {
    const pid = seedProfile();
    const pack = seedBaseAndTailored(pid);
    const hits = await ground(pid, 'renewal pricing', pack, 'interview');
    expect(hits.some((c) => c.sourceType === 'tailored')).toBe(true);
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(false); // deliberately replaced
  });

  it('never suppresses the real résumé in a meeting', async () => {
    const pid = seedProfile();
    const pack = seedBaseAndTailored(pid);
    const hits = await ground(pid, 'renewal pricing', pack, 'meeting');
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(true);
  });

  it('nor in a companion session or a voice quick ask', async () => {
    const pid = seedProfile();
    const pack = seedBaseAndTailored(pid);
    // 'companion' is the mode voiceService files a quick ask under, so this
    // covers the no-session path that used to inherit an 'interview' default.
    const hits = await ground(pid, 'renewal pricing', pack, 'companion');
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(true);
  });

  it('defaults CLOSED at the retrieval layer — a caller must opt in', async () => {
    // ground() is not the only door: retrieve() is exported. Its tailored
    // substitution must be opt-in, so a future caller that forgets the option
    // cannot re-introduce the suppression.
    const pid = seedProfile();
    const pack = seedBaseAndTailored(pid);
    const hits = await retrieve(pid, 'renewal pricing', 5, pack);
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(true);
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
      await archiveSession(seedSession(pid, packOf(pid), FOUR_TURNS));
    }
    expect(archiveChunks(pid).length).toBeGreaterThan(SESSION_ARCHIVE_MAX);

    const hits = await retrieve(pid, 'renewal pricing', 5, null);
    expect(hits.filter((c) => c.sourceType === 'session').length).toBeLessThanOrEqual(
      SESSION_ARCHIVE_MAX,
    );
    expect(hits.some((c) => c.sourceType === 'resume')).toBe(true);
  });
});
