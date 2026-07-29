import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Memory subsystem suite: extraction gates, review lifecycle, scoped hybrid
 * recall, and the deletion cascade — against REAL persistence (sql.js +
 * drizzle migrations) with a scripted provider registry.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  chatJson: (async () => ({})) as (req: { system: string; user: string }) => Promise<unknown>,
  chatCalls: 0,
  embedCalls: 0,
  identity: { provider: 'fake', model: 'test-embed', dim: 4 },
}));

/** Deterministic topic embedding: dim0 = answer-style, dim1 = stripe/api,
 *  dim2 = deadlines; a tiny shared component keeps every cosine defined. */
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  return Float32Array.from([
    t.includes('concise') || t.includes('bullet') ? 1 : 0,
    t.includes('stripe') || t.includes('api') ? 1 : 0,
    t.includes('deadline') ? 1 : 0,
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
        embedOne: async (text: string) => {
          h.embedCalls += 1;
          return fakeVec(text);
        },
      };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { extractMemoryCandidates, extractionSchema } from './extractor';
import { approveMemory, updateMemory } from './memoryService';
import { buildIndex, hasExactAnchor, lexicalScore, tokenize } from './lexical';
import { MEMORY_MIN_SCORE, recallMemories } from './recall';

let seq = 0;
const T0 = 1_700_000_000_000;

function seedProfile(): string {
  const id = `mem-p${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'M', targetRole: 'PM' }).run();
  return id;
}
function seedPack(profileId: string, memoryEnabled = 1): string {
  const id = `mem-j${++seq}`;
  h.db
    .insert(schema.contextPacks)
    .values({ id, profileId, title: `Pack ${id}`, memoryEnabled })
    .run();
  return id;
}
function seedSession(profileId: string, packId: string | null, turns: string[]): string {
  const id = `mem-s${++seq}`;
  h.db
    .insert(schema.sessions)
    .values({ id, profileId, packId, mode: 'meeting', kind: 'live', interviewType: 'general', status: 'stopped' })
    .run();
  for (const t of turns) {
    h.db
      .insert(schema.transcriptChunks)
      .values({ id: crypto.randomUUID(), sessionId: id, speaker: 'them', text: t, isFinal: 1 })
      .run();
  }
  return id;
}
function seedApproved(
  profileId: string,
  content: string,
  over: Partial<typeof schema.memories.$inferInsert> = {},
): string {
  const id = `mem-m${++seq}`;
  const vec = fakeVec(content);
  h.db
    .insert(schema.memories)
    .values({
      id,
      profileId,
      category: 'preference',
      content,
      status: 'approved',
      confidence: 0.9,
      importance: 0.5,
      embedProvider: h.identity.provider,
      embedModel: h.identity.model,
      embedDim: h.identity.dim,
      embedVector: Buffer.from(vec.buffer.slice(0)),
      updatedAt: T0,
      ...over,
    })
    .run();
  return id;
}

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.chatCalls = 0;
  h.embedCalls = 0;
  settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
});

describe('extraction gates', () => {
  const candidates = (over: object = {}) => async () => ({
    candidates: [
      { category: 'preference', content: 'Prefers concise bullet answers in meetings.', scope: 'profile', confidence: 0.9, importance: 0.6 },
      { category: 'fact', content: 'Low-confidence stray remark about lunch spots.', scope: 'profile', confidence: 0.3, importance: 0.2 },
      { category: 'fact', content: 'My password is hunter2 for the staging box.', scope: 'profile', confidence: 0.95, importance: 0.9 },
    ],
    ...over,
  });

  it('no capture before consent — the model is never even called', async () => {
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    const pid = seedProfile();
    const sid = seedSession(pid, null, ['We should meet weekly.', 'Agreed, Mondays work.']);
    h.chatJson = candidates();
    expect(await extractMemoryCandidates(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('a conversation with no Space extracts nothing — and is never sent to the model', async () => {
    // A Space is where a conversation is kept; with none there is nowhere to
    // put what it taught, so the transcript never leaves the machine either.
    const pid = seedProfile();
    const sid = seedSession(pid, null, ['We should meet weekly.', 'Agreed, Mondays work.']);
    h.chatJson = candidates();
    expect(await extractMemoryCandidates(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('a Space that opted out extracts nothing', async () => {
    const pid = seedProfile();
    const packId = seedPack(pid, 0);
    const sid = seedSession(pid, packId, ['We should meet weekly.', 'Agreed.']);
    h.chatJson = candidates();
    expect(await extractMemoryCandidates(sid)).toBe(0);
    expect(h.chatCalls).toBe(0);
  });

  it('saves only benign, confident candidates — as PENDING, with provenance', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, seedPack(pid), ['I prefer bullet points.', 'Noted, concise it is.']);
    h.chatJson = candidates();
    expect(await extractMemoryCandidates(sid)).toBe(1); // floor-drop + sensitive-drop
    const rows = memoriesRepo.list({ profileId: pid });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', category: 'preference' });
    expect(rows[0].sourceRefs).toEqual([{ type: 'session', id: sid }]);
    // The secret NEVER touched the database in any status.
    expect(rows.some((r) => r.content.includes('hunter2'))).toBe(false);
  });

  it('an invalid extraction shape stores nothing', async () => {
    const pid = seedProfile();
    const sid = seedSession(pid, null, ['Turn one.', 'Turn two.']);
    h.chatJson = async () => ({ candidates: [{ category: 'poem', content: 'x' }] });
    expect(await extractMemoryCandidates(sid)).toBe(0);
    expect(memoriesRepo.list({ profileId: pid })).toHaveLength(0);
  });

  it('schema caps candidates at 5 and validates ranges', () => {
    expect(
      extractionSchema.safeParse({
        candidates: Array.from({ length: 6 }, () => ({
          category: 'fact',
          content: 'Something long enough.',
          confidence: 0.9,
        })),
      }).success,
    ).toBe(false);
    expect(
      extractionSchema.safeParse({
        candidates: [{ category: 'fact', content: 'Something long enough.', confidence: 2 }],
      }).success,
    ).toBe(false);
  });
});

describe('review lifecycle', () => {
  it('approve embeds (with edits applied); reject/archive leave recall; delete removes row+vector', async () => {
    const pid = seedProfile();
    const id = memoriesRepo.insertCandidate({
      profileId: pid,
      packId: null,
      category: 'preference',
      content: 'Prefers concise answers.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [{ type: 'session', id: 's1' }],
    });

    const approved = await approveMemory(id, { content: 'Prefers concise bullet answers.' });
    expect(approved.status).toBe('approved');
    expect(approved.content).toBe('Prefers concise bullet answers.');
    expect(h.embedCalls).toBe(1);
    const row = h.db.select().from(schema.memories).all().find((r) => r.id === id)!;
    expect(row.embedModel).toBe('test-embed');
    expect(row.embedVector).not.toBeNull();

    // Content edit on an approved memory re-embeds; category-only edit doesn't.
    await updateMemory(id, { content: 'Prefers concise bullets in every meeting.' });
    expect(h.embedCalls).toBe(2);
    await updateMemory(id, { importance: 0.9 });
    expect(h.embedCalls).toBe(2);

    expect(memoriesRepo.setStatus(id, 'archived').status).toBe('archived');

    memoriesRepo.delete(id);
    expect(memoriesRepo.get(id)).toBeNull();
    expect(h.db.select().from(schema.memories).all().some((r) => r.id === id)).toBe(false);
  });

  it('a sensitive EDIT is refused — user paste cannot smuggle a secret in', async () => {
    const pid = seedProfile();
    const id = memoriesRepo.insertCandidate({
      profileId: pid,
      packId: null,
      category: 'fact',
      content: 'Benign fact about sprint cadence.',
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: [],
    });
    await expect(
      approveMemory(id, { content: 'The password is hunter2.' }),
    ).rejects.toThrow(/won't store/);
    expect(memoriesRepo.get(id)!.status).toBe('pending'); // untouched
  });
});

describe('scoped hybrid recall', () => {
  it('approved-only, scope-aware, expiry- and identity-filtered, capped, floor-gated', async () => {
    const pid = seedProfile();
    const p1 = seedPack(pid);
    const p2 = seedPack(pid);
    const hit = seedApproved(pid, 'Prefers concise bullet answers in meetings.');
    seedApproved(pid, 'Stripe panel cares about API design.', { packId: p2 }); // other Space
    seedApproved(pid, 'Concise summaries win.', { status: 'pending' }); // not approved
    seedApproved(pid, 'Concise bullet formatting preferred.', { expiresAt: T0 - 1 }); // expired
    seedApproved(pid, 'Bullet-first concise style.', { embedModel: 'old-model' }); // stale space
    seedApproved(pid, 'Deadline tracking happens in Linear.'); // semantically unrelated

    const out = await recallMemories(pid, 'concise bullet answers', p1, T0);
    expect(out.map((m) => m.id)).toEqual([hit]);
    expect(out[0].score).toBeGreaterThan(0.9);

    // lastUsedAt stamped on use.
    expect(memoriesRepo.get(hit)!.lastUsedAt).toBe(T0);
  });

  it('a Space-scoped memory surfaces only inside its Space', async () => {
    const pid = seedProfile();
    const p1 = seedPack(pid);
    const scoped = seedApproved(pid, 'Stripe interviewers drill into API design.', { packId: p1 });
    expect((await recallMemories(pid, 'stripe api design', p1, T0)).map((m) => m.id)).toEqual([
      scoped,
    ]);
    expect(await recallMemories(pid, 'stripe api design', null, T0)).toEqual([]);
  });

  it('importance/recency are tiebreakers, never substitutes for relevance', async () => {
    const pid = seedProfile();
    // Unrelated but "important" memory must NOT beat the relevant one — and
    // must not surface at all (below the semantic floor).
    seedApproved(pid, 'Deadline dashboards refresh nightly.', { importance: 1 });
    // Lexically identical twins so importance is the ONLY differentiator.
    const relevantLow = seedApproved(pid, 'Prefers concise bullet answers.', { importance: 0 });
    const relevantHigh = seedApproved(pid, 'Always concise bullet answers.', { importance: 1 });

    const out = await recallMemories(pid, 'concise bullet answers', null, T0);
    expect(out.map((m) => m.id)).toEqual([relevantHigh, relevantLow]); // importance breaks the tie
  });

  it('caps at MEMORY_TOP_K and clips long content to the budget', async () => {
    const pid = seedProfile();
    for (let i = 0; i < 4; i += 1) {
      seedApproved(pid, `Concise bullet preference variant ${i} ${'x'.repeat(400)}`);
    }
    const out = await recallMemories(pid, 'concise bullet preference', null, T0);
    expect(out).toHaveLength(3);
    expect(out.every((m) => m.content.length <= 300)).toBe(true);
  });

  it('consent off / Space opt-out short-circuit to [] without embedding', async () => {
    const pid = seedProfile();
    seedApproved(pid, 'Prefers concise bullet answers.');
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    expect(await recallMemories(pid, 'concise bullets', null, T0)).toEqual([]);
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
    const off = seedPack(pid, 0);
    expect(await recallMemories(pid, 'concise bullets', off, T0)).toEqual([]);
  });
});

/**
 * Lexical scoring — the half of retrieval embeddings are bad at.
 *
 * fakeVec only encodes three topics, so a memory about a ticket id embeds to
 * near-nothing — which is exactly the real-world case: identifiers, versions,
 * and figures blur under embedding. These tests pin the behaviour that lets
 * such a memory come back when the query names it.
 */
describe('lexical scoring', () => {
  it('keeps identifiers whole AND splits them, and drops stopwords', () => {
    const t = tokenize('What about ticket ATL-4471 for the v2.0.1 release?');
    expect(t).toContain('atl-4471'); // whole identifier
    expect(t).toContain('4471'); // …and its parts, for partial recall
    expect(t).toContain('v2.0.1');
    expect(t).not.toContain('the');
    expect(t).not.toContain('what');
  });

  it('weights a rare token far above a common one', () => {
    const corpus = [
      'The team discussed the roadmap in the meeting.',
      'The team discussed the roadmap again today.',
      'The team discussed the roadmap at length.',
      'Ticket ATL-4471 tracks the checkout regression.',
    ];
    const index = buildIndex(corpus);
    const q = tokenize('ATL-4471');
    expect(lexicalScore(q, corpus[3], index)).toBeGreaterThan(0.9);
    expect(lexicalScore(q, corpus[0], index)).toBe(0);
    // "roadmap" appears in three of four documents, so it discriminates little.
    expect(index.idf.get('roadmap')!).toBeLessThan(index.idf.get('atl-4471')!);
  });

  it('anchors on rarity by document frequency, not corpus-size-dependent idf', () => {
    // The same token must anchor in a 2-memory store and a 40-memory one; an
    // absolute idf threshold silently stops working in small corpora.
    const small = buildIndex([
      'Ticket ATL-4471 tracks the checkout regression.',
      'A note about teams.',
    ]);
    const large = buildIndex([
      'Ticket ATL-4471 tracks the checkout regression.',
      ...Array.from({ length: 39 }, (_, i) => `Routine note number ${i} about the weekly sync.`),
    ]);
    for (const index of [small, large]) {
      expect(hasExactAnchor(tokenize('ATL-4471'), 'Ticket ATL-4471 tracks it', index)).toBe(true);
    }
    // A word the corpus repeats is not an anchor, however long: "note" appears
    // in 39 of the 40 memories, so sharing it says nothing.
    expect(
      hasExactAnchor(tokenize('note'), 'Routine note number 5 about the weekly sync.', large),
    ).toBe(false);
    // Short words never anchor even when rare — "api" appears once here and
    // still cannot pull a memory in on its own.
    expect(hasExactAnchor(tokenize('api'), 'A note about the api.', small)).toBe(false);
  });
});

describe('hybrid recall', () => {
  // fakeVec maps text to a topic vector; anything with NO topic word lands on
  // the same near-zero point, so two topicless strings score cosine 1.0 against
  // each other. Every fixture below therefore carries a topic word, which is
  // what makes "the semantic score is genuinely low" a real condition rather
  // than an artifact.
  it('recalls a memory the semantic floor alone would discard', async () => {
    const pid = seedProfile();
    // Topic 'stripe/api' — the query has no topic word, so their cosine is far
    // below the floor. Exactly the real case: an identifier the embedding blurs.
    seedApproved(pid, 'Ticket ATL-4471 tracks the stripe api checkout regression.');
    seedApproved(pid, 'Prefers concise bullet answers in meetings.');
    seedApproved(pid, 'The deadline for the quarterly report is Friday.');

    const out = await recallMemories(pid, 'status of ATL-4471', null, T0);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('ATL-4471');
    expect(out[0].score).toBeLessThan(MEMORY_MIN_SCORE); // semantic alone would have dropped it
  });

  it('still ranks a strong semantic match first', async () => {
    const pid = seedProfile();
    seedApproved(pid, 'Prefers concise bullet answers in meetings.');
    seedApproved(pid, 'Ticket ATL-4471 tracks the stripe api checkout regression.');

    const out = await recallMemories(pid, 'concise bullet preference', null, T0);
    expect(out[0].content).toContain('concise bullet');
  });

  it('does not surface a memory sharing only common words', async () => {
    const pid = seedProfile();
    seedApproved(pid, 'The team met about the stripe api plan.');
    seedApproved(pid, 'The team met again about the stripe api plan.');

    // No rare shared token, and the topic words differ → neither path fires.
    const out = await recallMemories(pid, 'quarterly budget spreadsheet', null, T0);
    expect(out).toEqual([]);
  });

  it('a lexically perfect match still needs the query to name something specific', async () => {
    const pid = seedProfile();
    // Every memory mentions the team and the plan, so those tokens are common
    // in THIS corpus and single out nothing.
    seedApproved(pid, 'The team agreed the plan for the stripe api rollout.');
    seedApproved(pid, 'The team revisited the plan for the stripe api rollout.');
    seedApproved(pid, 'The team signed off the plan for the stripe api work.');

    // Lexically this is a *perfect* match — every query token is present — and
    // semantically it is nowhere near. It must still return nothing: the
    // lexical path exists to surface exact anchors (an id, a figure, a name),
    // not to let a vague query drag in every memory that shares its filler.
    expect(await recallMemories(pid, 'team plan', null, T0)).toEqual([]);
  });
});
