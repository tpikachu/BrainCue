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
import { approveMemory, createMemory, updateMemory } from './memoryService';
import { buildMemoryExport, importMemories, inspectMemoryExport } from './portability';
import { recallMemories } from './recall';

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
    const sid = seedSession(pid, null, ['I prefer bullet points.', 'Noted, concise it is.']);
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
 * Supersession — the truthfulness guarantee (docs/14-MEMORY.md §3.1).
 *
 * The failure this prevents: a fact changes, both values sit in the store,
 * both match the query, and an agent grounded in memory confidently states
 * the old answer. After M1 there is exactly ONE current row per fact key, and
 * the previous value survives as history rather than as a competing truth.
 */
describe('supersession', () => {
  const KEY = 'project:atlas/launch-date';

  const pendingFact = (profileId: string, content: string, factKey: string | null = KEY) =>
    memoriesRepo.insertCandidate({
      profileId,
      packId: null,
      category: 'fact',
      content,
      confidence: 0.9,
      importance: 0.7,
      sourceRefs: [],
      factKey,
      sourceKind: 'extracted',
    });

  it('approving a new value retires the old one and promotes the revision', async () => {
    const pid = seedProfile();
    const oldId = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const newId = pendingFact(pid, 'The launch deadline moved to May 9.');

    await approveMemory(newId);

    const before = memoriesRepo.get(oldId)!;
    const after = memoriesRepo.get(newId)!;
    expect(before.supersededBy).toBe(newId);
    expect(before.validTo).not.toBeNull();
    expect(after.supersededBy).toBeNull();
    expect(after.validTo).toBeNull();
    expect(after.revision).toBe(before.revision + 1);
    expect(memoriesRepo.currentByFactKey(pid, null, KEY)!.id).toBe(newId);
  });

  it('recall returns ONLY the current value — the stale fact is unreachable', async () => {
    const pid = seedProfile();
    seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const newId = pendingFact(pid, 'The launch deadline moved to May 9.');
    await approveMemory(newId);

    const out = await recallMemories(pid, 'launch deadline', null, T0);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('May 9');
    expect(out.some((m) => m.content.includes('March 3'))).toBe(false);
  });

  it('keeps the superseded row as history, newest first, with its vector cleared', async () => {
    const pid = seedProfile();
    const oldId = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const newId = pendingFact(pid, 'The launch deadline moved to May 9.');
    await approveMemory(newId);

    const chain = memoriesRepo.history(pid, KEY);
    expect(chain.map((m) => m.id)).toEqual([newId, oldId]);
    // Belt-and-braces: even a retrieval path that forgot the supersededBy
    // filter cannot surface it, because it has no vector left to match.
    const raw = memoriesRepo.recallRows(pid, null, T0);
    expect(raw.some((r) => r.id === oldId)).toBe(false);
  });

  it('excludes a superseded row on the FILTER alone, vector intact', () => {
    // The previous test passes for two independent reasons (the supersededBy
    // filter AND the cleared vector), so it cannot prove the filter works.
    // Here the row keeps a valid embedding and is only marked superseded —
    // if recallRows ever drops the isNull(supersededBy) condition, this fails.
    const pid = seedProfile();
    const live = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    // supersededBy ONLY — validTo stays null and the vector stays intact, so
    // the supersession filter is the single thing that can exclude this row.
    const retired = seedApproved(pid, 'The launch deadline was January 8.', {
      factKey: KEY,
      supersededBy: live,
    });

    // seedApproved always embeds, so `retired` carries a valid vector and a
    // null validTo: supersededBy is the only thing that can exclude it.
    const rows = memoriesRepo.recallRows(pid, null, T0);
    expect(rows.map((r) => r.id)).toEqual([live]);
    expect(memoriesRepo.get(retired)!.supersededBy).toBe(live);
  });

  it('leaves free-text memories (no factKey) coexisting', async () => {
    const pid = seedProfile();
    seedApproved(pid, 'Prefers concise bullet answers.');
    const second = pendingFact(pid, 'Prefers concise bullet summaries up front.', null);
    await approveMemory(second);

    const rows = memoriesRepo.recallRows(pid, null, T0);
    expect(rows).toHaveLength(2); // nothing was retired
    expect(rows.every((r) => r.supersededBy == null)).toBe(true);
  });

  it('surfaces a conflict for review instead of applying it', async () => {
    const pid = seedProfile();
    const oldId = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const newId = pendingFact(pid, 'The launch deadline moved to May 9.');

    const conflicts = memoriesRepo.conflicts(pid);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].candidate.id).toBe(newId);
    expect(conflicts[0].current.id).toBe(oldId);
    expect(memoriesRepo.get(oldId)!.supersededBy).toBeNull(); // nothing applied yet
  });

  it('scopes supersession per Space — a Space value never retires the global one', async () => {
    const pid = seedProfile();
    const pack = seedPack(pid);
    const globalId = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const scoped = memoriesRepo.insertCandidate({
      profileId: pid,
      packId: pack,
      category: 'fact',
      content: 'For this Space the launch deadline is June 1.',
      confidence: 0.9,
      importance: 0.7,
      sourceRefs: [],
      factKey: KEY,
    });
    await approveMemory(scoped);

    expect(memoriesRepo.get(globalId)!.supersededBy).toBeNull();
    expect(memoriesRepo.currentByFactKey(pid, pack, KEY)!.id).toBe(scoped);
    expect(memoriesRepo.currentByFactKey(pid, null, KEY)!.id).toBe(globalId);
  });
});

describe('consolidation + authoring', () => {
  const KEY = 'project:atlas/launch-date';

  it('drops a re-stated identical fact and re-confirms the existing one', async () => {
    const pid = seedProfile();
    const existing = seedApproved(pid, 'The launch deadline is March 3.', {
      factKey: KEY,
      lastUsedAt: null,
    });
    const sid = seedSession(pid, null, ['We are still on for March 3.', 'Right, noted.']);
    h.chatJson = async () => ({
      candidates: [
        {
          category: 'fact',
          // Same claim, different case/punctuation — normalization catches it.
          content: 'the launch deadline is march 3',
          scope: 'profile',
          confidence: 0.9,
          importance: 0.7,
          factKey: KEY,
        },
      ],
    });

    expect(await extractMemoryCandidates(sid)).toBe(0); // nothing new stored
    expect(memoriesRepo.list({ profileId: pid, status: 'pending' })).toHaveLength(0);
    expect(memoriesRepo.get(existing)!.lastUsedAt).not.toBeNull(); // re-confirmed
  });

  it('stores a contradicting fact as pending — never auto-supersedes', async () => {
    const pid = seedProfile();
    const existing = seedApproved(pid, 'The launch deadline is March 3.', { factKey: KEY });
    const sid = seedSession(pid, null, ['Deadline slipped.', 'It is May 9 now.']);
    h.chatJson = async () => ({
      candidates: [
        {
          category: 'fact',
          content: 'The launch deadline moved to May 9.',
          scope: 'profile',
          confidence: 0.9,
          importance: 0.8,
          factKey: KEY,
        },
      ],
    });

    expect(await extractMemoryCandidates(sid)).toBe(1);
    expect(memoriesRepo.get(existing)!.supersededBy).toBeNull(); // untouched
    const pending = memoriesRepo.list({ profileId: pid, status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].factKey).toBe(KEY);
  });

  it('rejects a malformed factKey rather than storing a bad one', () => {
    const parsed = extractionSchema.safeParse({
      candidates: [
        {
          category: 'fact',
          content: 'The launch deadline moved to May 9.',
          scope: 'profile',
          confidence: 0.9,
          importance: 0.8,
          factKey: 'Not A Valid Key',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('portability: export → import restores memory into a clean profile', async () => {
    const source = seedProfile();
    seedApproved(source, 'Prefers concise bullet answers.');
    seedApproved(source, 'The launch deadline is March 3.', { factKey: KEY });
    memoriesRepo.insertCandidate({
      profileId: source,
      packId: null,
      category: 'fact',
      content: 'A candidate still awaiting review.',
      confidence: 0.8,
      importance: 0.5,
      sourceRefs: [],
    });

    const file = buildMemoryExport(source);
    expect(file.memories).toHaveLength(3); // approved + pending, nothing rejected
    expect(inspectMemoryExport(file)).toMatchObject({ valid: true, count: 3, vectorsUsable: true });

    const target = seedProfile();
    const before = h.embedCalls;
    const summary = await importMemories(target, file, 'restore');

    expect(summary.imported).toBe(3);
    expect(summary.blocked).toBe(0);
    // Vectors travelled with the file and the embedding identity matches, so
    // restoring cost no embedding calls at all.
    expect(summary.reEmbedded).toBe(0);
    expect(h.embedCalls).toBe(before);
    // The approved ones are immediately recallable in the new profile.
    const out = await recallMemories(target, 'launch deadline', null, T0);
    expect(out[0].content).toContain('March 3');
  });

  it('portability: import is idempotent — the same file twice adds nothing', async () => {
    const source = seedProfile();
    seedApproved(source, 'Prefers concise bullet answers.');
    const file = buildMemoryExport(source);

    const target = seedProfile();
    expect((await importMemories(target, file, 'restore')).imported).toBe(1);
    const second = await importMemories(target, file, 'restore');
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(memoriesRepo.list({ profileId: target })).toHaveLength(1);
  });

  it('portability: review mode lands everything pending; restore preserves approval', async () => {
    const source = seedProfile();
    seedApproved(source, 'Prefers concise bullet answers.');
    const file = buildMemoryExport(source);

    const reviewed = seedProfile();
    await importMemories(reviewed, file, 'review');
    expect(memoriesRepo.list({ profileId: reviewed, status: 'approved' })).toHaveLength(0);
    expect(memoriesRepo.list({ profileId: reviewed, status: 'pending' })).toHaveLength(1);

    const restored = seedProfile();
    await importMemories(restored, file, 'restore');
    expect(memoriesRepo.list({ profileId: restored, status: 'approved' })).toHaveLength(1);
  });

  it('portability: the sensitive filter blocks a hand-edited file in BOTH modes', async () => {
    const target = seedProfile();
    const hostile = {
      format: 'braincue.memory' as const,
      version: 1,
      exportedAt: T0,
      embedding: null,
      memories: [
        { content: 'My password is hunter2 for the staging box.', category: 'fact' as const },
        { content: 'A perfectly ordinary preference about meetings.', category: 'preference' as const },
      ],
    };
    for (const mode of ['review', 'restore'] as const) {
      const p = seedProfile();
      const s = await importMemories(p, hostile, mode);
      expect(s.blocked).toBe(1);
      expect(s.imported).toBe(1);
    }
    expect(memoriesRepo.list({ profileId: target })).toHaveLength(0); // untouched
  });

  it('portability: rejects a file that is not a BrainCue export', async () => {
    const pid = seedProfile();
    await expect(importMemories(pid, { hello: 'world' })).rejects.toThrow();
    expect(inspectMemoryExport({ hello: 'world' }).valid).toBe(false);
  });

  it('portability: an unknown Space becomes profile-global, never a dangling ref', async () => {
    const pid = seedProfile();
    const summary = await importMemories(
      pid,
      {
        format: 'braincue.memory' as const,
        version: 1,
        exportedAt: T0,
        embedding: null,
        memories: [
          { content: 'Scoped to a Space that does not exist here.', category: 'fact' as const, scope: 'Ghost Space' },
        ],
      },
      'review',
    );
    expect(summary.imported).toBe(1);
    expect(summary.unmatchedScopes).toEqual(['Ghost Space']);
    expect(memoriesRepo.list({ profileId: pid })[0].packId).toBeNull();
  });

  it('portability: restoring a fact supersedes the value already here', async () => {
    const source = seedProfile();
    seedApproved(source, 'The launch deadline moved to May 9.', { factKey: KEY });
    const file = buildMemoryExport(source);

    const target = seedProfile();
    const stale = seedApproved(target, 'The launch deadline is March 3.', { factKey: KEY });
    const summary = await importMemories(target, file, 'restore');

    expect(summary.superseded).toBe(1);
    expect(memoriesRepo.get(stale)!.supersededBy).not.toBeNull();
    const out = await recallMemories(target, 'launch deadline', null, T0);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('May 9');
  });

  it('portability: an export never carries credentials or settings', () => {
    const pid = seedProfile();
    seedApproved(pid, 'Prefers concise bullet answers.');
    const serialized = JSON.stringify(buildMemoryExport(pid));
    for (const forbidden of ['apiKey', 'api_key', 'sk-', 'settings', 'embedProvider']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('authored memories land pending and still pass the sensitive gate', () => {
    const pid = seedProfile();
    const m = createMemory({
      profileId: pid,
      packId: null,
      category: 'fact',
      content: 'I report to Sarah Chen.',
      factKey: 'person:sarah-chen/reports-to',
    });
    expect(m.status).toBe('pending'); // authoring is not a bypass of review
    expect(m.sourceKind).toBe('authored');
    expect(m.confidence).toBe(1);

    expect(() =>
      createMemory({
        profileId: pid,
        packId: null,
        category: 'fact',
        content: 'My password is hunter2 for the staging box.',
      }),
    ).toThrow();
  });
});
