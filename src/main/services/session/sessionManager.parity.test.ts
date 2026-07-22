import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';
import type { AnswerEvent } from '../openai/answer';

/**
 * Live-pipeline PARITY tests (v2 baseline guardrail).
 *
 * These pin the current interview pipeline's observable behavior — event
 * order, persistence, the classification gate, and the answer-slot/abort
 * ownership rules — so the Prompt-3 engine extraction can prove it changed
 * nothing. Persistence is REAL (repositories + drizzle migrations on an
 * in-memory sql.js database — see test/dbHarness.ts); providers, windows,
 * transcriber, and broadcast are mocked at the same seams the engine will own.
 */

interface FakeTranscriberShape {
  cb: {
    onDelta: (t: string) => void;
    onFinal: (t: string) => void;
    onError: (m: string) => void;
    onStatus?: (s: string) => void;
  };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  appendAudio: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  transcribers: [] as unknown[],
  classify: (async () => ({ isQuestion: false, type: 'clarification', confidence: 0, strategy: '' })) as (
    text: string,
  ) => Promise<{ isQuestion: boolean; type: string; confidence: number; strategy: string }>,
  retrieve: (async () => []) as (...args: unknown[]) => Promise<unknown[]>,
  retrieveCalls: [] as unknown[][],
  streamAnswer: null as unknown as (input: Record<string, unknown>) => AsyncGenerator<AnswerEvent>,
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
vi.mock('../security/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  // The provider layer imports the client factory; nothing may reach the
  // network from a unit test.
  openai: () => {
    throw new Error('network disabled in tests');
  },
}));
vi.mock('../openai/transcription', () => ({ transcribeChunk: vi.fn() }));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({ classifyQuestion: (t: string) => h.classify(t) }));
vi.mock('../openai/answer', () => ({
  streamAnswer: (input: Record<string, unknown>) => h.streamAnswer(input),
}));
vi.mock('../rag/retriever', () => ({
  retrieve: (...args: unknown[]) => {
    h.retrieveCalls.push(args);
    return h.retrieve(...args);
  },
}));
vi.mock('../openai/realtime', () => ({
  RealtimeTranscriber: class {
    cb: unknown;
    start = vi.fn();
    stop = vi.fn();
    appendAudio = vi.fn();
    constructor(cb: unknown) {
      this.cb = cb;
      h.transcribers.push(this);
    }
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { sessionManager } from './sessionManager';

const evts = (ch: string) => h.events.filter((e) => e.ch === ch);
const firstIndex = (ch: string) => h.events.findIndex((e) => e.ch === ch);
const lastTranscriber = () => h.transcribers[h.transcribers.length - 1] as FakeTranscriberShape;

function seedProfile(id: string) {
  h.db
    .insert(schema.profiles)
    .values({ id, name: 'Test User', targetRole: 'SWE', parsedResume: JSON.stringify({ skills: ['ts'] }) })
    .run();
}

function defaultStream() {
  return (async function* (): AsyncGenerator<AnswerEvent> {
    yield { type: 'delta', token: 'Hello' };
    yield { type: 'delta', token: ' world' };
    yield { type: 'meta', riskWarning: null };
    yield { type: 'usage', prompt: 10, completion: 5 };
  })();
}

let seq = 0;

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});

beforeEach(() => {
  h.events.length = 0;
  h.transcribers.length = 0;
  h.retrieveCalls.length = 0;
  h.classify = async () => ({ isQuestion: false, type: 'clarification', confidence: 0, strategy: '' });
  h.retrieve = async () => [];
  h.streamAnswer = () => defaultStream();
});

/** Start a live session on a fresh profile; returns ids. */
function startSession(interviewType: 'behavioral' | 'coding' = 'behavioral') {
  const profileId = `p${++seq}`;
  seedProfile(profileId);
  const session = sessionManager.start(profileId, interviewType);
  return { profileId, session };
}

describe('session start', () => {
  it('creates a live session row, starts the transcriber, and seeds the overlay', () => {
    const { profileId, session } = startSession();

    expect(session.status).toBe('live');
    expect(session.kind).toBe('live');
    expect(session.interviewType).toBe('behavioral');
    const row = h.db.select().from(schema.sessions).all().find((r) => r.id === session.id)!;
    expect(row.profileId).toBe(profileId);
    expect(row.startedAt).not.toBeNull();

    expect(h.transcribers).toHaveLength(1);
    expect(lastTranscriber().start).toHaveBeenCalledOnce();

    expect(evts(EVENTS.sessionState).at(0)?.payload).toEqual({ status: 'live', paused: false });
    expect(evts(EVENTS.answerPrefs)).toHaveLength(1); // Cue Card toggles seeded
    expect(evts(EVENTS.clientInfo).at(0)?.payload).toMatchObject({ hasResume: true, hasJd: false });
    sessionManager.stop(session.id);
  });
});

describe('finalized transcript', () => {
  it('persists the turn and broadcasts a final transcript delta even when not a question', async () => {
    const { session } = startSession();
    await sessionManager.processFinalTranscript(session.id, 'So let me pull up your file.');

    const rows = h.db
      .select()
      .from(schema.transcriptChunks)
      .all()
      .filter((r) => r.sessionId === session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ speaker: 'interviewer', isFinal: 1 });
    expect(evts(EVENTS.transcriptDelta).at(-1)?.payload).toEqual({
      text: 'So let me pull up your file.',
      isFinal: true,
      speaker: 'interviewer',
    });
    expect(evts(EVENTS.questionDetected)).toHaveLength(0);
    sessionManager.stop(session.id);
  });
});

describe('question classification gate', () => {
  it('does not answer when the classifier says not-a-question', async () => {
    const { session } = startSession();
    h.classify = async () => ({ isQuestion: false, type: 'clarification', confidence: 0.9, strategy: '' });
    await sessionManager.processFinalTranscript(session.id, 'Anyway, moving on.');

    expect(h.db.select().from(schema.detectedQuestions).all().filter((q) => q.sessionId === session.id)).toHaveLength(0);
    expect(h.retrieveCalls).toHaveLength(0);
    expect(evts(EVENTS.answerDelta)).toHaveLength(0);
    sessionManager.stop(session.id);
  });

  it('does not answer below the 0.4 confidence floor', async () => {
    const { session } = startSession();
    h.classify = async () => ({ isQuestion: true, type: 'behavioral', confidence: 0.3, strategy: '' });
    await sessionManager.processFinalTranscript(session.id, 'Hmm?');

    expect(h.retrieveCalls).toHaveLength(0);
    expect(evts(EVENTS.answerDelta)).toHaveLength(0);
    sessionManager.stop(session.id);
  });
});

describe('detected question → retrieval → streamed answer → persistence', () => {
  it('runs the full pipeline in order and persists the answer', async () => {
    const { profileId, session } = startSession();
    h.classify = async () => ({ isQuestion: true, type: 'behavioral', confidence: 0.92, strategy: 'star' });
    h.retrieve = async () => [{ id: 'c1', sourceType: 'resume', content: 'Led a migration', score: 0.8 }];

    const q = 'Tell me about a time you led a project?';
    await sessionManager.processFinalTranscript(session.id, q);

    // Question row + broadcast
    const qRow = h.db
      .select()
      .from(schema.detectedQuestions)
      .all()
      .find((r) => r.sessionId === session.id)!;
    expect(qRow).toMatchObject({ text: q, type: 'behavioral' });
    expect(qRow.transcriptChunkId).not.toBeNull(); // linked to the persisted turn

    // Retrieval: profile scope, top-5, no job selected
    expect(h.retrieveCalls).toEqual([[profileId, q, 5, null]]);

    // Transparency + stream events, in pipeline order
    expect(evts(EVENTS.contextSent).at(0)?.payload).toMatchObject({ questionId: qRow.id });
    expect(evts(EVENTS.answerDelta).map((e) => (e.payload as { token: string }).token)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(evts(EVENTS.answerDone).at(-1)?.payload).toEqual({ questionId: qRow.id });
    const order = [
      firstIndex(EVENTS.questionDetected),
      firstIndex(EVENTS.contextSent),
      firstIndex(EVENTS.answerDelta),
      firstIndex(EVENTS.answerDone),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order); // strictly increasing

    // Persistence
    const answer = h.db
      .select()
      .from(schema.aiAnswers)
      .all()
      .find((a) => a.questionId === qRow.id)!;
    expect(answer.directAnswer).toBe('Hello world');
    expect(JSON.parse(answer.tokens!)).toEqual({ prompt: 10, completion: 5 });
    sessionManager.stop(session.id);
  });
});

describe('stop / cleanup', () => {
  it('stops the transcriber, marks the row, prompts save, and deadens the pipeline', async () => {
    const { session } = startSession();
    const transcriber = lastTranscriber();

    sessionManager.stop(session.id);

    const row = h.db.select().from(schema.sessions).all().find((r) => r.id === session.id)!;
    expect(row.status).toBe('stopped');
    expect(row.endedAt).not.toBeNull();
    expect(transcriber.stop).toHaveBeenCalled();
    expect(evts(EVENTS.sessionState).at(-1)?.payload).toEqual({ status: 'stopped', paused: false });
    expect(evts(EVENTS.savePrompt).at(0)?.payload).toMatchObject({ sessionId: session.id, questionCount: 0 });
    expect(evts(EVENTS.clientInfo).at(-1)?.payload).toBeNull(); // Cue Card client panel cleared

    // A late transcript final after stop must be a no-op (no live session).
    h.events.length = 0;
    await sessionManager.processFinalTranscript(session.id, 'Late words.');
    expect(evts(EVENTS.transcriptDelta)).toHaveLength(0);
    expect(
      h.db.select().from(schema.transcriptChunks).all().filter((r) => r.sessionId === session.id),
    ).toHaveLength(0);
  });

  it('manual ask is refused when idle', async () => {
    expect(await sessionManager.askActive('Anyone there?')).toEqual({ ok: false });
  });
});

describe('stale abort vs regeneration (slot-ownership rules)', () => {
  it('an aborted stream can never overwrite the newer regeneration', async () => {
    const { session } = startSession();

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let calls = 0;
    h.streamAnswer = (input: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) {
        return (async function* (): AsyncGenerator<AnswerEvent> {
          yield { type: 'delta', token: 'A1' };
          await gateA; // parked mid-stream until the test releases it
          if ((input.signal as AbortSignal).aborted) throw new Error('aborted by regenerate');
          yield { type: 'delta', token: 'A2' };
        })();
      }
      return (async function* (): AsyncGenerator<AnswerEvent> {
        yield { type: 'delta', token: 'B1' };
        yield { type: 'delta', token: 'B2' };
      })();
    };

    // Answer A starts streaming and parks after its first token.
    const pA = sessionManager.answerQuestion(session.id, 'Tricky question?');
    await vi.waitFor(() => {
      expect(evts(EVENTS.answerDelta).some((e) => (e.payload as { token: string }).token === 'A1')).toBe(true);
    });

    // Regenerate the SAME question: A is aborted, B streams to completion.
    const { regenerated } = await sessionManager.regenerate();
    expect(regenerated).toBe(true);
    expect(evts(EVENTS.answerReset)).toHaveLength(1);

    const qId = (evts(EVENTS.questionDetected).at(0)?.payload as { id: string }).id;
    const answersFor = () =>
      h.db.select().from(schema.aiAnswers).all().filter((a) => a.questionId === qId);
    expect(answersFor()).toHaveLength(1);
    expect(answersFor()[0].directAnswer).toBe('B1B2');

    // NOW the stale stream A wakes up, sees the abort, and dies — it must not
    // delete or replace B's persisted answer, and must not wedge the pipeline.
    releaseA();
    await pA; // abort path resolves (never rejects) with the questionId
    expect(answersFor()).toHaveLength(1);
    expect(answersFor()[0].directAnswer).toBe('B1B2');

    // Pipeline is still healthy: a fresh question streams normally.
    h.streamAnswer = () => defaultStream();
    h.events.length = 0;
    await sessionManager.answerQuestion(session.id, 'Follow-up question?');
    expect(evts(EVENTS.answerDelta).map((e) => (e.payload as { token: string }).token)).toEqual([
      'Hello',
      ' world',
    ]);

    // Dual-write mirrors ai_answers exactly: the aborted A stream produced NO
    // contribution — only B's completed take exists for the tricky question.
    const tricky = h.db
      .select()
      .from(schema.contributions)
      .all()
      .filter((c) => c.title === 'Tricky question?');
    expect(tricky).toHaveLength(1);
    expect(tricky[0]).toMatchObject({ kind: 'answer', status: 'completed', body: 'B1B2' });
    sessionManager.stop(session.id);
  });
});

describe('engine behaviors surfaced by the extraction (v2)', () => {
  it('direct ask (summoned) bypasses the classifier entirely', async () => {
    const { session } = startSession();
    let classifyCalls = 0;
    h.classify = async () => {
      classifyCalls += 1;
      return { isQuestion: false, type: 'clarification', confidence: 0, strategy: '' };
    };

    const { ok } = await sessionManager.askActive('What is your greatest strength?');
    expect(ok).toBe(true);
    expect(classifyCalls).toBe(0);
    expect(evts(EVENTS.answerDelta).length).toBeGreaterThan(0);

    // Manual-ask question rows keep the v1 defaults.
    const q = h.db
      .select()
      .from(schema.detectedQuestions)
      .all()
      .find((r) => r.sessionId === session.id)!;
    expect(q).toMatchObject({ type: 'behavioral', confidence: 1, strategy: '' });
    sessionManager.stop(session.id);
  });

  it('a paused session ignores finals; resuming re-arms the pipeline', async () => {
    const { session } = startSession();
    const rowsFor = () =>
      h.db.select().from(schema.transcriptChunks).all().filter((r) => r.sessionId === session.id);

    sessionManager.togglePause(session.id);
    await sessionManager.processFinalTranscript(session.id, 'Are you still there?');
    expect(rowsFor()).toHaveLength(0); // pause wins: nothing persisted, nothing answered

    sessionManager.togglePause(session.id);
    await sessionManager.processFinalTranscript(session.id, 'Ok, back to it.');
    expect(rowsFor()).toHaveLength(1);
    sessionManager.stop(session.id);
  });

  it('a completed answer dual-writes one contribution row with provenance', async () => {
    const { session } = startSession();
    h.classify = async () => ({ isQuestion: true, type: 'behavioral', confidence: 0.9, strategy: 'star' });
    h.retrieve = async () => [{ id: 'cx', sourceType: 'resume', content: 'Led a rewrite', score: 0.9 }];

    await sessionManager.processFinalTranscript(session.id, 'Tell me about a rewrite you led?');

    const contribs = h.db
      .select()
      .from(schema.contributions)
      .all()
      .filter((c) => c.sessionId === session.id);
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toMatchObject({ kind: 'answer', status: 'completed', body: 'Hello world' });

    const refs = JSON.parse(contribs[0].sourceRefs!) as { type: string; id: string }[];
    const qId = (evts(EVENTS.questionDetected).at(0)?.payload as { id: string }).id;
    expect(refs).toContainEqual({ type: 'question', id: qId });
    expect(refs).toContainEqual({ type: 'chunk', id: 'cx' });

    // ai_answers row still exists in parallel — the parity source of truth.
    expect(h.db.select().from(schema.aiAnswers).all().some((a) => a.questionId === qId)).toBe(true);
    sessionManager.stop(session.id);
  });
});
