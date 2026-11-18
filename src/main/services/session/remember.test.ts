import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M6: "Keep it" reports what ACTUALLY happened, per half, against real
 * persistence (sql.js + the migrations) with a scripted provider. The summary
 * and the memory suggestions each come back as their own typed outcome —
 * done, declined and why, or failed and why — so the save prompt never infers
 * a reason from a zero count; the transcript is kept in every case; and the
 * destination is validated wherever the picker found it.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  /** By request: the archive asks for 900 output tokens, extraction for 600. */
  archive: (async () => ({})) as () => Promise<unknown>,
  extract: (async () => ({ candidates: [] })) as () => Promise<unknown>,
  calls: 0,
}));

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
        json: (req: { maxOutputTokens?: number }) => {
          h.calls += 1;
          return req.maxOutputTokens === 900 ? h.archive() : h.extract();
        },
      };
    }
    if (cap === 'embedding') {
      return {
        identity: () => ({ provider: 'fake', model: 'test-embed', dim: 2 }),
        embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0.1])),
      };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { rememberSession } from './remember';

let seq = 0;
const profile = () => {
  const id = `rm-p${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'A' }).run();
  return id;
};
const space = (profileId: string, memoryEnabled = 1) => {
  const id = `rm-j${++seq}`;
  h.db.insert(schema.contextPacks).values({ id, profileId, title: `Space ${id}`, memoryEnabled }).run();
  return id;
};
const TURNS = [
  'Thanks for making time — we wanted to talk about the renewal.',
  'Right, the current pricing runs out at the end of the quarter.',
  'We can hold the current rate if you commit to two years.',
  'Let me take that back to the team and confirm by Friday.',
];
function session(profileId: string, packId: string | null, turns = TURNS, over: Partial<typeof schema.sessions.$inferInsert> = {}) {
  const id = `rm-s${++seq}`;
  h.db
    .insert(schema.sessions)
    .values({ id, profileId, packId, mode: 'meeting', kind: 'live', interviewType: 'general', status: 'stopped', ...over })
    .run();
  for (const text of turns) {
    h.db.insert(schema.transcriptChunks).values({ id: crypto.randomUUID(), sessionId: id, speaker: 'them', text, isFinal: 1 }).run();
  }
  return id;
}
const GOOD = {
  topic: 'Acme renewal',
  summary: 'Acme discussed renewal terms; the rate holds for a two-year commitment.',
  participants: ['Acme'],
  keyQuotes: [],
  sections: { decisions: ['Hold the rate for two years'], actionItems: [], openQuestions: [] },
};
const provider = () => 'anthropic';
const transcriptOf = (id: string) => h.db.select().from(schema.transcriptChunks).all().filter((t) => t.sessionId === id);
const packOf = (id: string) => h.db.select().from(schema.sessions).all().find((s) => s.id === id)?.packId;

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.calls = 0;
  h.archive = async () => GOOD;
  h.extract = async () => ({ candidates: [] });
  settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '1');
  settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
});

describe('Keep reports each half as it actually went', () => {
  it('done: summary saved; memory suggestions off (no consent) — and the provider is named', async () => {
    const p = profile();
    const s = session(p, space(p));
    const r = await rememberSession(s, undefined, provider);
    expect(r.summary).toMatchObject({ status: 'done' });
    expect(r.summary.count).toBeGreaterThan(0);
    expect(r.memory).toEqual({ status: 'off', count: 0 });
    expect(r.provider).toBe('anthropic');
    expect(r.kept).toBe(true);
  });

  it('failed: the provider call throws — the reason comes back, the transcript is untouched', async () => {
    const p = profile();
    const s = session(p, space(p));
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
    h.archive = async () => {
      throw new Error('No Anthropic API key');
    };
    h.extract = async () => {
      throw new Error('No Anthropic API key');
    };
    const r = await rememberSession(s, undefined, provider);
    expect(r.summary).toEqual({ status: 'failed', count: 0, error: 'No Anthropic API key' });
    expect(r.memory).toEqual({ status: 'failed', count: 0, error: 'No Anthropic API key' });
    expect(transcriptOf(s)).toHaveLength(4); // kept, whatever processing did
    // A retry succeeds — Keep can be pressed again.
    h.archive = async () => GOOD;
    h.extract = async () => ({ candidates: [] });
    const again = await rememberSession(s, undefined, provider);
    expect(again.summary.status).toBe('done');
    expect(again.memory.status).toBe('nothing-new'); // ran; nothing to suggest
  });

  it('failed: an unusable summary shape is a failure, not a silent zero', async () => {
    const p = profile();
    const r = await rememberSession(session(p, space(p)), undefined, provider);
    expect(r.summary.status).toBe('done');
    h.archive = async () => ({ nope: true });
    const bad = await rememberSession(session(p, space(p)), undefined, provider);
    expect(bad.summary).toMatchObject({ status: 'failed', error: expect.stringMatching(/unusable shape/) });
  });

  it('no Space: nothing is summarised or sent, and no provider is named', async () => {
    const p = profile();
    const r = await rememberSession(session(p, null), null, provider);
    expect(r.summary.status).toBe('no-space');
    expect(r.memory.status).toBe('off');
    expect(r.provider).toBeNull();
    expect(h.calls).toBe(0);
  });

  it('the Space opted out / summaries switched off / too little said — each named, nothing sent', async () => {
    const p = profile();
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
    const optedOut = await rememberSession(session(p, space(p, 0)), undefined, provider);
    expect([optedOut.summary.status, optedOut.memory.status]).toEqual(['space-off', 'space-off']);

    settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '0');
    settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '0');
    const off = await rememberSession(session(p, space(p)), undefined, provider);
    expect([off.summary.status, off.memory.status]).toEqual(['off', 'off']);

    settingsRepo.set(SETTINGS_KEYS.sessionArchiveEnabled, '1');
    const short = await rememberSession(session(p, space(p), ['Hi.']), undefined, provider);
    expect(short.summary.status).toBe('too-short');
    expect(h.calls).toBe(0);
  });

  it('a practice drill is never summarised', async () => {
    const p = profile();
    const r = await rememberSession(session(p, space(p), TURNS, { mode: 'practice', kind: 'sparring' }), undefined, provider);
    expect(r.summary.status).toBe('practice');
  });
});

describe('the destination is validated wherever the picker found it', () => {
  it('a Space deleted since it was chosen is refused — the session is not filed into it', async () => {
    const p = profile();
    const home = space(p);
    const s = session(p, home);
    await expect(rememberSession(s, 'rm-gone', provider)).rejects.toThrow(/no longer exists/);
    expect(packOf(s)).toBe(home); // untouched
    expect(h.calls).toBe(0);
  });

  it("another profile's Space is refused", async () => {
    const a = profile();
    const b = profile();
    const s = session(a, null);
    await expect(rememberSession(s, space(b), provider)).rejects.toThrow(/another profile/);
    expect(packOf(s)).toBeNull();
  });

  it('an older Space (anywhere in the list) files fine; null files it out of every Space', async () => {
    const p = profile();
    const older = space(p);
    for (let i = 0; i < 3; i++) space(p); // newer ones on top of the list
    const s = session(p, null);
    const r = await rememberSession(s, older, provider);
    expect(r.packId).toBe(older);
    expect(packOf(s)).toBe(older);
    const out = await rememberSession(s, null, provider);
    expect(out.packId).toBeNull();
    expect(out.summary.status).toBe('no-space');
  });
});
