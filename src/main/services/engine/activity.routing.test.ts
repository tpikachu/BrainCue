import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';
import { ACTIVITIES, ACTIVITY_ORDER } from '@shared/activities';
import type { ContextPackKind } from '@shared/types';

/**
 * The user picks an ACTIVITY and nothing else; the engine derives the mode.
 *
 * shared/activities.test.ts pins the TABLE — that `job` maps to `interview`,
 * that only interviews get the assessed framing. It cannot pin that the engine
 * reads the table: `resolveMode` could return a constant and every assertion
 * over there would still pass, while every standup ran as an interview. That is
 * the same shape as the bug the meeting-framing suite was written for, so this
 * drives the REAL engine.start and reads back what was persisted.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
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
vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, payload: unknown) => h.events.push({ ch, payload }),
}));
vi.mock('../../windows/overlayWindow', () => ({
  getOverlayWindow: () => null,
  showOverlay: vi.fn(),
}));
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
vi.mock('../openai/questions', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../rag/retriever', () => ({ retrieve: vi.fn(async () => []) }));
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'realtimeStt') return { open: () => ({ appendAudio: vi.fn(), stop: vi.fn() }) };
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { engine } from './engine';

const T0 = 1_700_000_000_000;
let seq = 0;

function makeProfile(): string {
  const id = `ap${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id, name: 'Test User', parsedResume: '{"skills":[]}' })
    .run();
  return id;
}

const row = (sessionId: string) =>
  h.db
    .select()
    .from(schema.sessions)
    .all()
    .find((s) => s.id === sessionId)!;

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterAll(() => {
  engine.shutdown();
  vi.useRealTimers();
});
beforeEach(() => {
  h.events.length = 0;
});

describe('engine.start: the activity chooses the mode', () => {
  it.each(ACTIVITY_ORDER)('runs %s in the mode its activity declares', (kind) => {
    const session = engine.start(makeProfile(), 'general', null, 'key_points', { activity: kind });
    expect(session.mode).toBe(ACTIVITIES[kind as ContextPackKind].mode);
    // Persisted, not just returned — Reports and resume read the row.
    expect(row(session.id).mode).toBe(ACTIVITIES[kind as ContextPackKind].mode);
  });

  it('records the ACTIVITY too, because the mode does not carry it', () => {
    // A project call and a standup both run 'meeting'. Storing only the derived
    // mode would erase the difference, and a session started without a Space
    // would have no record of what it was at all.
    const project = engine.start(makeProfile(), 'general', null, 'key_points', {
      activity: 'project',
    });
    const standup = engine.start(makeProfile(), 'general', null, 'key_points', {
      activity: 'meeting',
    });
    expect(row(project.id).mode).toBe(row(standup.id).mode);
    expect(row(project.id).activity).toBe('project');
    expect(row(standup.id).activity).toBe('meeting');
  });

  it('gives interview framing to interviews and to nothing else', () => {
    for (const kind of ACTIVITY_ORDER) {
      const s = engine.start(makeProfile(), 'general', null, 'key_points', { activity: kind });
      expect(s.mode === 'interview', kind).toBe(kind === 'job');
    }
  });
});

describe('the callers that have no activity', () => {
  it('falls back to the interview pipeline when nothing is passed', () => {
    // Mock and sparring rehearsals come through the facade with no activity.
    const s = engine.start(makeProfile(), 'behavioral', null, 'key_points');
    expect(s.mode).toBe('interview');
    expect(row(s.id).activity).toBeNull();
  });

  it('lets an explicit mode win, so rehearsals keep working', () => {
    const s = engine.start(makeProfile(), 'general', null, 'key_points', { mode: 'meeting' });
    expect(s.mode).toBe('meeting');
  });

  it('restores both on resume — a standup resumes as a standup', () => {
    const started = engine.start(makeProfile(), 'general', null, 'key_points', {
      activity: 'meeting',
    });
    engine.stop(started.id);
    const resumed = engine.resume(started.id);
    expect(resumed.mode).toBe('meeting');
    expect(resumed.activity).toBe('meeting');
  });
});

describe('what the Cue Card is told', () => {
  const clientInfo = () =>
    h.events.filter((e) => e.ch === EVENTS.clientInfo).at(-1)?.payload as { title: string };

  it('names the call by what the user said it was, when there is no Space', () => {
    engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'personal' });
    expect(clientInfo().title).toBe(ACTIVITIES.personal.label);
  });

  it('still says Interview for a rehearsal, which has no activity', () => {
    engine.start(makeProfile(), 'general', null, 'key_points');
    expect(clientInfo().title).toBe('Interview');
  });
});
