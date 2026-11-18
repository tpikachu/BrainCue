import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';
import type { RollbackResult } from '@shared/types';

/**
 * M6 (M1's carried follow-up): after a failed startup rollback, Stop must
 * follow ONE policy whichever window presses it. The rollback is now held in
 * main: `engine.rollback` records it before stopping, so a stop that throws
 * leaves it pending, and a later `stopActive` (the Cue Card's Stop) runs the
 * same rollback — no save prompt for the failed attempt, a new session
 * removed, a resumed one kept — instead of a plain stop that offered Keep.
 *
 * Drives the REAL engine against the real schema (sql.js). The stop failure is
 * controlled: the next N database calls throw, the way a locked or failing DB
 * would — before teardown, so the session really is still live.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  failDb: 0,
}));

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return {
    schema,
    db: () => {
      if (!h.db) throw new Error('test db not initialized');
      if (h.failDb > 0) {
        h.failDb--;
        throw new Error('database is locked');
      }
      return h.db;
    },
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});
vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, payload: unknown) => h.events.push({ ch, payload }),
}));
vi.mock('../../windows/overlayWindow', () => ({ getOverlayWindow: () => null, showOverlay: vi.fn() }));
vi.mock('../../windows/mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  openai: () => {
    throw new Error('network disabled in tests');
  },
}));
vi.mock('../openai/answer', () => ({ streamAnswer: vi.fn() }));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({
  classifyQuestion: async () => ({ isQuestion: false, type: 'clarification', confidence: 0, strategy: '' }),
}));
vi.mock('../rag/retriever', () => ({ retrieve: vi.fn(async () => []) }));
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'realtimeStt') return { open: () => ({ appendAudio: vi.fn(), stop: vi.fn() }) };
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { engine } from './engine';

let seq = 0;
function makeProfile(): string {
  const id = `rb${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'Test User', parsedResume: '{"skills":[]}' }).run();
  return id;
}
const prompts = () => h.events.filter((e) => e.ch === EVENTS.savePrompt);
const settled = () => h.events.filter((e) => e.ch === EVENTS.sessionRollback).map((e) => e.payload as RollbackResult);
const row = (id: string) => h.db.select().from(schema.sessions).all().find((s) => s.id === id);
const turnsOf = (id: string) => h.db.select().from(schema.transcriptChunks).all().filter((t) => t.sessionId === id);

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
afterAll(() => engine.shutdown());
beforeEach(() => {
  h.events.length = 0;
  h.failDb = 0;
});

describe('a failed start is rolled back by ONE policy, from either window', () => {
  it('new session: the rollback stop fails → the Cue Card Stop retries the SAME rollback (removed, no Keep prompt)', () => {
    const s = engine.start(makeProfile(), 'general', null, 'general', { activity: 'job' });

    // The dashboard's rollback: its stop fails before teardown.
    h.failDb = 1;
    const first = engine.rollback(s.id, true);
    expect(first).toMatchObject({ sessionId: s.id, stopped: false, error: 'database is locked' });
    expect(row(s.id)?.status).toBe('live'); // never claimed stopped
    expect(prompts()).toHaveLength(0);

    // The Cue Card's Stop (no session id) — previously a plain stop that
    // showed the Keep/Discard prompt for the failed attempt.
    const r = engine.stopActive();
    expect(r).toMatchObject({ stopped: true, rollback: { sessionId: s.id, stopped: true, removed: true } });
    expect(row(s.id)).toBeUndefined(); // the empty new session is removed
    expect(prompts()).toHaveLength(0); // no Keep/Discard for the failed attempt
    // Both windows are told, both times — the failure and the confirmation.
    expect(settled().map((x) => [x.stopped, x.removed])).toEqual([
      [false, undefined],
      [true, true],
    ]);
  });

  it('resumed session: the retry stops it but KEEPS its earlier content, and a later legitimate stop prompts again', () => {
    const profileId = makeProfile();
    const s = engine.start(profileId, 'general', null, 'general', { activity: 'job' });
    h.db
      .insert(schema.transcriptChunks)
      .values({ id: `t-${s.id}`, sessionId: s.id, speaker: 'interviewer', text: 'Tell me about the migration.', isFinal: 1 })
      .run();
    engine.stop(s.id);
    h.events.length = 0;

    // A resume whose audio fails, with a failing rollback stop.
    engine.resume(s.id);
    h.failDb = 1;
    expect(engine.rollback(s.id, false).stopped).toBe(false);
    // Cue Card Stop → the same rollback: stopped, NOT removed, no prompt.
    const r = engine.stopActive();
    expect(r.rollback).toMatchObject({ stopped: true });
    expect(r.rollback?.removed).toBeUndefined();
    expect(row(s.id)?.status).toBe('stopped');
    expect(turnsOf(s.id)).toHaveLength(1); // earlier content intact
    expect(prompts()).toHaveLength(0);

    // The rollback is settled: a later successful resume, stopped normally
    // from the Cue Card, IS offered for saving.
    engine.resume(s.id);
    expect(engine.stopActive()).toEqual({ stopped: true });
    expect(prompts()).toHaveLength(1);
    expect((prompts()[0].payload as { sessionId: string }).sessionId).toBe(s.id);
  });

  it('a Cue Card Stop that fails again stays pending and says so', () => {
    const s = engine.start(makeProfile(), 'general', null, 'general', { activity: 'job' });
    h.failDb = 1;
    engine.rollback(s.id, true);
    h.failDb = 1;
    const r = engine.stopActive();
    expect(r).toMatchObject({ stopped: false, rollback: { stopped: false, error: 'database is locked' } });
    expect(row(s.id)?.status).toBe('live');
    // …and the next try (dashboard or Cue Card) completes it.
    expect(engine.stopActive().rollback).toMatchObject({ stopped: true, removed: true });
    expect(prompts()).toHaveLength(0);
  });

  it('stopped but the removal fails: reported as exactly that', () => {
    const s = engine.start(makeProfile(), 'general', null, 'general', { activity: 'job' });
    const spy = vi.spyOn(memoriesRepo, 'deleteBySession').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const r = engine.rollback(s.id, true);
    spy.mockRestore();
    expect(r).toMatchObject({ stopped: true, removed: false, error: 'disk full' });
    expect(row(s.id)?.status).toBe('stopped'); // stopped is true; the empty record remains
    expect(prompts()).toHaveLength(0);
  });

  it('an ordinary Cue Card Stop (no rollback pending) still offers Keep/Discard', () => {
    const s = engine.start(makeProfile(), 'general', null, 'general', { activity: 'job' });
    expect(engine.stopActive()).toEqual({ stopped: true });
    expect(prompts().map((p) => (p.payload as { sessionId: string }).sessionId)).toEqual([s.id]);
    expect(settled()).toHaveLength(0);
  });
});
