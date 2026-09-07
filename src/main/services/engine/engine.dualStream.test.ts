import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';

/**
 * A live session hears BOTH the call and the user's microphone: engine.begin
 * opens one transcriber per stream from the activity's capture plan
 * (shared/activities.ts), tags each with a speaker, and routes each audio
 * frame to the transcriber of the stream it came from. This drives the REAL
 * engine.start against a scripted realtimeStt provider and reads back what
 * was opened, what was persisted and what was broadcast.
 */

interface Opened {
  cb: {
    onDelta: (t: string) => void;
    onFinal: (t: string) => void;
    onError?: (m: string) => void;
    onStatus?: (s: string) => void;
  };
  appendAudio: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  opened: [] as unknown[],
  classifyCalls: [] as string[],
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
vi.mock('../openai/questions', () => ({
  classifyQuestion: async (text: string) => {
    h.classifyCalls.push(text);
    return { isQuestion: false, type: 'clarification', confidence: 0, strategy: '' };
  },
}));
vi.mock('../rag/retriever', () => ({ retrieve: vi.fn(async () => []) }));
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'realtimeStt') {
      return {
        open: (cb: Opened['cb']) => {
          const t: Opened = { cb, appendAudio: vi.fn(), stop: vi.fn() };
          h.opened.push(t);
          return { appendAudio: t.appendAudio, stop: t.stop };
        },
      };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { engine } from './engine';

let seq = 0;
function makeProfile(): string {
  const id = `ds${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id, name: 'Test User', parsedResume: '{"skills":[]}' })
    .run();
  return id;
}

const opened = () => h.opened as Opened[];
const deltas = () =>
  h.events
    .filter((e) => e.ch === EVENTS.transcriptDelta)
    .map((e) => e.payload as { text: string; speaker: string; isFinal: boolean });
const turns = (sessionId: string) =>
  h.db
    .select()
    .from(schema.transcriptChunks)
    .all()
    .filter((t) => t.sessionId === sessionId)
    .map((t) => ({ speaker: t.speaker, text: t.text }));
const pcm = (fill: number): ArrayBuffer => {
  const a = new Int16Array(64).fill(fill);
  return a.buffer;
};

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
afterAll(() => engine.shutdown());
beforeEach(() => {
  h.events.length = 0;
  h.opened.length = 0;
  h.classifyCalls.length = 0;
});

describe('a call opens two transcribers, each tagged with a speaker', () => {
  it('interview: the call is the interviewer, the microphone is the candidate', async () => {
    const s = engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'job' });
    expect(opened()).toHaveLength(2);
    const [system, mic] = opened();

    // Frames go to the transcriber of the stream they came from.
    engine.feedRealtimeAudio(s.id, pcm(1000), 'system');
    engine.feedRealtimeAudio(s.id, pcm(1000), 'mic');
    engine.feedRealtimeAudio(s.id, pcm(1000)); // no tag = the remote side (v1 renderer)
    expect(system.appendAudio).toHaveBeenCalledTimes(2);
    expect(mic.appendAudio).toHaveBeenCalledTimes(1);

    system.cb.onFinal('Tell me about a migration you led?');
    mic.cb.onFinal('Sure — the Postgres one.');
    // The mic's turn is held ~1.5 s by the echo guard before it is committed.
    await vi.waitFor(() => expect(turns(s.id)).toHaveLength(2), { timeout: 4000 });
    expect(turns(s.id)).toEqual([
      { speaker: 'interviewer', text: 'Tell me about a migration you led?' },
      { speaker: 'candidate', text: 'Sure — the Postgres one.' },
    ]);
    expect(deltas().filter((d) => d.isFinal).map((d) => d.speaker)).toEqual(['interviewer', 'candidate']);
    // Only the call's turn was put to the question classifier.
    expect(h.classifyCalls).toEqual(['Tell me about a migration you led?']);
  });

  it('meeting: the call is `them`, the microphone is `you`', () => {
    engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'meeting' });
    expect(opened()).toHaveLength(2);
    const [system, mic] = opened();
    system.cb.onDelta('what is');
    mic.cb.onDelta('I think');
    // Interim text is shown for the trigger stream only — the UI keeps ONE
    // in-flight line, and two streams' partials interleaved would be unreadable.
    expect(deltas()).toEqual([{ text: 'what is', speaker: 'them', isFinal: false }]);
  });

  it('the Cue Card level meter follows whichever stream is louder', () => {
    const s = engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'meeting' });
    const level = () =>
      (h.events.filter((e) => e.ch === EVENTS.audioLevel).at(-1)?.payload as { level: number }).level;
    engine.feedRealtimeAudio(s.id, pcm(300), 'system');
    const quiet = level();
    // The throttle is time-based; nudge the clock past it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 1_000);
      engine.feedRealtimeAudio(s.id, pcm(20_000), 'mic');
      expect(level()).toBeGreaterThan(quiet);
      vi.setSystemTime(Date.now() + 1_000);
      engine.feedRealtimeAudio(s.id, pcm(300), 'system'); // the call is quiet, the mic is still loud
      expect(level()).toBeGreaterThan(quiet);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sessions that hear one stream', () => {
  it('solo: the microphone alone, and it IS the trigger source (speaker `you`)', () => {
    const s = engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'solo' });
    expect(opened()).toHaveLength(1);
    const [mic] = opened();
    engine.feedRealtimeAudio(s.id, pcm(1000), 'mic');
    expect(mic.appendAudio).toHaveBeenCalledTimes(1);
    mic.cb.onDelta('remind me');
    expect(deltas()).toEqual([{ text: 'remind me', speaker: 'you', isFinal: false }]);
    // No system stream: a stray system-tagged frame is dropped, not misrouted.
    engine.feedRealtimeAudio(s.id, pcm(1000), 'system');
    expect(mic.appendAudio).toHaveBeenCalledTimes(1);
  });

  it('no activity (rehearsal facades, v1 rows): the remote side only, as v1 did', () => {
    engine.start(makeProfile(), 'behavioral');
    expect(opened()).toHaveLength(1);
    const [system] = opened();
    system.cb.onDelta('so');
    expect(deltas()[0].speaker).toBe('interviewer');
  });

  it('stopping the session stops every transcriber', () => {
    const s = engine.start(makeProfile(), 'general', null, 'key_points', { activity: 'project' });
    const [system, mic] = opened();
    engine.stop(s.id);
    expect(system.stop).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalledTimes(1);
  });
});
