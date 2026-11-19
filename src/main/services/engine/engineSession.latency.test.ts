import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M7.2b / PERF-01 — the latency record the live pipeline writes: each stage
 * on its own, an outcome for every detected question (failed and missed
 * ones included), memory recalled with the documents, and never a word of
 * transcript or answer text. Real EngineSession, scheduler, grounding,
 * recall and recorder; simulated providers on fake timers.
 */

const EMBED = 700;
const TTFT = 1000;
const IDENTITY = { provider: 'openai', model: 'text-embedding-3-small', dim: 3 };

const h = vi.hoisted(() => ({
  qid: 0,
  generate: 'ok' as 'ok' | 'auth-error',
  markUsed: [] as string[][],
  embedTexts: [] as string[],
  // Memory state the answer path must honour at the moment it sends.
  memoryEnabled: true,
  packId: null as string | null,
  packMemory: true,
  memoryRows: ['m1'],
  memoryText: 'Prefers to lead with the payments migration.',
  inputs: [] as { memories?: { id: string; content: string }[] }[],
  opened: [] as string[],
}));

vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: vi.fn(),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: vi.fn(),
  emitContributionOpen: (p: { contributionId: string }) => h.opened.push(p.contributionId),
  emitContributionReset: vi.fn(),
  emitContributionTake: () => {},
  emitContributionTitle: vi.fn(),
}));
vi.mock('../../providers/normalizeError', () => ({ normalizeProviderError: (e: unknown) => String(e) }));
vi.mock('../../providers/taskRoute', () => ({
  taskRoute: () => ({ provider: 'openai', model: 'gpt-6-luna' }),
  retryRouteAfterModelError: () => null,
}));
vi.mock('../../db/repositories/profiles.repo', () => ({
  profilesRepo: { get: () => ({ id: 'p1', name: 'Test User', targetRole: 'Engineer', targetCompany: null }) },
}));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./persistence/enginePersistence', () => ({
  enginePersistence: {
    finalTranscript: () => `tc${++h.qid}`,
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: h.packId }),
    sessionTimeline: () => ({ turns: [] }),
    insertQuestion: () => `lq${++h.qid}`,
    replaceAnswer: vi.fn(),
    insertContribution: () => 'c1',
    setFollowup: vi.fn(),
    question: () => null,
    updateQuestionText: vi.fn(),
  },
}));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    identity: () => IDENTITY,
    embedOne: (text: string) => {
      h.embedTexts.push(text);
      return new Promise<Float32Array>((r) => setTimeout(() => r(Float32Array.from([1, 0, 0])), EMBED));
    },
  }),
}));
vi.mock('../rag/vectorStore', () => {
  const chunk = { id: 'ch1', sourceType: 'resume', content: 'Scaled the payments service to 40k rps.' };
  return {
    sqliteVectorStore: {
      scope: () => [{ ...chunk, embedded: { provider: 'openai', model: 'text-embedding-3-small', dim: 3 } }],
      search: () => [{ ...chunk, score: 0.9 }],
      topStory: () => null,
    },
  };
});
vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { memoryEnabled: 'memory_enabled' },
  settingsRepo: { get: (k: string) => (k === 'memory_enabled' ? (h.memoryEnabled ? '1' : '0') : null) },
}));
vi.mock('../../db/repositories/jobs.repo', () => ({
  contextPacksRepo: { get: (id: string) => (id === h.packId ? { id, memoryEnabled: h.packMemory } : null) },
}));
vi.mock('../../db/repositories/memories.repo', () => ({
  memoriesRepo: {
    recallRows: () =>
      h.memoryRows.map((id) => ({
        id,
        category: 'fact',
        content: h.memoryText,
        importance: 0.5,
        updatedAt: 0,
        lastUsedAt: null,
        embedProvider: 'openai',
        embedModel: 'text-embedding-3-small',
        embedDim: 3,
        embedVector: Buffer.from(Float32Array.from([1, 0, 0]).buffer),
      })),
    markUsed: (ids: string[]) => h.markUsed.push(ids),
  },
}));

import { EngineSession } from './engineSession';
import { latency, setLatencySink } from './metrics/latencyStore';
import { clearLiveEmbedCache } from '../rag/liveEmbed';
import { PAINT_GRACE_MS, type QuestionTiming } from './metrics/latency';
import type { ModeDefinition } from './modeDefinition';

const mode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: {
    evaluate: async (text: string) => ({
      act: true,
      kind: 'answer' as const,
      question: { type: /design/.test(text) ? 'system_design' : 'behavioral', confidence: 0.9, strategy: '' },
      reason: 'q',
    }),
  },
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  async *generate(input) {
    h.inputs.push({ memories: input.memories?.map((m) => ({ id: m.id, content: m.content })) });
    await new Promise((r) => setTimeout(r, TTFT));
    if (input.signal?.aborted) throw new Error('aborted');
    if (h.generate === 'auth-error') throw Object.assign(new Error('bad key'), { status: 401 });
    yield { type: 'delta', token: '**I scaled' };
    yield { type: 'delta', token: ' it by sharding.**' };
  },
};

const session = () =>
  new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: h.packId,
    mode,
    settings: { interviewType: 'general', answerFormat: 'general', pronunciation: false, presence: 'balanced' },
    ephemeral: false,
  });

let sunk: QuestionTiming[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-18T09:00:00Z'));
  sunk = [];
  setLatencySink((t) => sunk.push(t));
  h.generate = 'ok';
  h.markUsed.length = 0;
  h.embedTexts.length = 0;
  h.memoryEnabled = true;
  h.packId = null;
  h.packMemory = true;
  h.memoryRows = ['m1'];
  h.memoryText = 'Prefers to lead with the payments migration.';
  h.inputs.length = 0;
  h.opened.length = 0;
  clearLiveEmbedCache();
});
afterEach(() => {
  setLatencySink(null);
  vi.useRealTimers();
});

const settle = async (p: Promise<unknown>) => {
  let done = false;
  void p.finally(() => (done = true)).catch(() => {});
  for (let t = 0; t < 60_000 && !done; t += 50) await vi.advanceTimersByTimeAsync(50);
  await p.catch(() => {});
};

describe('the latency record of a detected question', () => {
  it('times each stage on its own; memory is recalled with the documents on the interim; the record carries no text', async () => {
    const s = session();
    const Q = 'How did you scale the payments service at your last company?';
    s.prefetchGrounding('How did you scale the payments service at your last company');
    await vi.advanceTimersByTimeAsync(1200);
    // The prefetch embedded once — documents and memory share it.
    expect(h.embedTexts).toHaveLength(1);
    expect(h.markUsed).toEqual([]); // not marked until an answer uses it
    const finalAt = Date.now();
    await settle(s.onTranscriptFinal(Q, 'interviewer', { finalAt, speechEndAt: finalAt - 600, speechEndSource: 'vad' }));
    const id = latency.all().at(-1)!.questionId;
    latency.mark(id, { firstUsefulAt: finalAt + TTFT + 30 }, latency.get(id)!.take); // the overlay's paint report

    const t = sunk.at(-1)!;
    expect(t).toMatchObject({
      questionId: id,
      outcome: 'answered',
      category: 'general',
      format: 'general',
      questionType: 'behavioral',
      speechEndSource: 'vad',
      speechEndAt: finalAt - 600,
      prefetched: true,
      chunks: 1,
      memories: 1,
      provider: 'openai',
      model: 'gpt-6-luna',
      firstUsefulAt: finalAt + TTFT + 30,
    });
    expect(t.retrievalMs).toBe(EMBED);
    expect(t.recallMs).toBe(EMBED);
    expect(t.requestAt! - t.dispatchAt!).toBe(0); // context was already there
    expect(t.firstTokenAt! - t.requestAt!).toBe(TTFT);
    expect(h.markUsed).toEqual([['m1']]);
    expect(h.inputs[0].memories?.map((m) => m.id)).toEqual(['m1']); // an allowed prefetch is still used
    expect(h.embedTexts).toHaveLength(1); // no second, serial embedding for memory
    // Ids, timestamps, counts, codes — never the words.
    const json = JSON.stringify(sunk);
    expect(json).not.toMatch(/payments|scaled|sharding|migration/i);
  });

  it('a discarded prefetch never marks its memories used', async () => {
    const s = session();
    s.prefetchGrounding('What is our budget for the third quarter campaign');
    await vi.advanceTimersByTimeAsync(1200);
    await settle(s.onTranscriptFinal('Why did you leave your last role?'));
    // Only the answered question's recall marked m1 — once.
    expect(h.markUsed).toEqual([['m1']]);
  });

  it('a system-design question is Technical; a provider failure is written as failed with its kind — still in the sample', async () => {
    const s = session();
    h.generate = 'auth-error';
    await settle(s.onTranscriptFinal('How would you design a rate limiter for our public API?'));
    const t = sunk.at(-1)!;
    expect(t).toMatchObject({ outcome: 'failed', reason: 'auth', category: 'technical', questionType: 'system_design' });
    expect(t.firstTokenAt).toBeUndefined();
    const s2 = latency.summary().byCategory.technical.all;
    expect(s2.outcomes.failed).toBeGreaterThanOrEqual(1);
    expect(s2.endToEnd.unanswered).toBeGreaterThanOrEqual(1);
  });

  it('a question waiting when the user pauses becomes a missed card — and a missed record, never a gap', async () => {
    const s = session();
    const first = s.onTranscriptFinal('Tell me about the hardest bug you ever fixed?');
    await vi.advanceTimersByTimeAsync(100);
    const second = s.onTranscriptFinal('Why do you want to work here instead of somewhere else?'); // queued behind it
    await vi.advanceTimersByTimeAsync(10);
    s.setPaused(true);
    await settle(first);
    await settle(second);
    // The first answer keeps streaming (Pause stops new answers, not this
    // one); with no paint report it is written after the grace period.
    await vi.advanceTimersByTimeAsync(EMBED + TTFT + PAINT_GRACE_MS);
    const missed = sunk.filter((t) => t.outcome === 'missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ reason: 'paused', category: 'general' });
    expect(sunk.filter((t) => t.outcome === 'answered')).toHaveLength(1);
  });

  it('stopping mid-answer writes the question as aborted', async () => {
    const s = session();
    const p = s.onTranscriptFinal('What would you change about our onboarding process?');
    await vi.advanceTimersByTimeAsync(EMBED + 200); // the provider has the request
    s.teardown();
    await settle(p);
    expect(sunk.at(-1)).toMatchObject({ outcome: 'aborted' });
  });
});

/** M7.2b review, finding 1: memory recalled on the interim must still be
 *  allowed — and still exist — when the final's answer is sent. */
describe('memory recalled on the interim is checked again before the answer is sent', () => {
  const Q = 'How did you scale the payments service at your last company?';
  async function prefetchThen(change: () => void) {
    const s = session();
    s.prefetchGrounding(Q.replace(/\?$/, ''));
    await vi.advanceTimersByTimeAsync(1200); // the prefetch's recall has finished
    expect(h.markUsed).toEqual([]);
    change();
    await settle(s.onTranscriptFinal(Q));
    s.teardown();
    expect(h.inputs).toHaveLength(1);
  }

  it('global memory turned off after the prefetch: nothing sent, nothing marked used', async () => {
    await prefetchThen(() => (h.memoryEnabled = false));
    expect(h.inputs[0].memories).toEqual([]);
    expect(h.markUsed.flat()).not.toContain('m1');
  });

  it("the Space's memory switch turned off after the prefetch: nothing sent", async () => {
    h.packId = 'space1';
    await prefetchThen(() => (h.packMemory = false));
    expect(h.inputs[0].memories).toEqual([]);
    expect(h.markUsed.flat()).not.toContain('m1');
  });

  it('a memory deleted (or no longer eligible) after the prefetch is not sent', async () => {
    await prefetchThen(() => (h.memoryRows = []));
    expect(h.inputs[0].memories).toEqual([]);
    expect(h.markUsed.flat()).not.toContain('m1');
  });

  it('a memory edited after the prefetch is sent with its current text', async () => {
    await prefetchThen(() => (h.memoryText = 'Leads with the ledger migration.'));
    expect(h.inputs[0].memories).toEqual([{ id: 'm1', content: 'Leads with the ledger migration.' }]);
  });

  it('control: memory off before a final with no prefetch is not sent', async () => {
    const s = session();
    h.memoryEnabled = false;
    await settle(s.onTranscriptFinal(Q));
    s.teardown();
    expect(h.inputs[0].memories).toEqual([]);
  });
});

/** M7.2b review, finding 2: Stop must not remove detected questions from
 *  the sample — nor open anything just to record them. */
describe('every accepted question is in the sample when the session stops', () => {
  it('Stop with A answering and B detected and queued: both are recorded as aborted, B before dispatch', async () => {
    const s = session();
    const first = s.onTranscriptFinal('How did you scale the payments service at your last company?');
    await vi.advanceTimersByTimeAsync(100);
    const second = s.onTranscriptFinal('Why do you want to work here instead of somewhere else?');
    await vi.advanceTimersByTimeAsync(10);
    s.teardown();
    await settle(first);
    await settle(second);
    const mine = sunk.filter((t) => t.sessionId === 's1');
    expect(mine.map((t) => [t.outcome, t.reason ?? null])).toEqual([
      ['aborted', 'stopped-before-dispatch'], // B — written by Stop itself
      ['aborted', null], // A — its stream ended by the abort
    ]);
    expect(h.opened).toHaveLength(1); // no card was opened for B
    expect(h.inputs).toHaveLength(0); // no request built for either after Stop
  });

  it('a missed card still waiting for the slot when Stop comes is recorded as missed, without a card', async () => {
    const s = session();
    const first = s.onTranscriptFinal('Tell me about the hardest bug you ever fixed?');
    await vi.advanceTimersByTimeAsync(100);
    const second = s.onTranscriptFinal('Why do you want to work here instead of somewhere else?');
    await vi.advanceTimersByTimeAsync(10);
    s.setPaused(true); // B becomes a missed card — deferred: A is still streaming
    expect(sunk.filter((t) => t.outcome === 'missed')).toHaveLength(0);
    s.teardown();
    await settle(first);
    await settle(second);
    expect(sunk.filter((t) => t.outcome === 'missed').map((t) => t.reason)).toEqual(['paused']);
    expect(h.opened).toHaveLength(1);
    // Two detected questions, two records: the denominator is whole.
    expect(sunk.filter((t) => t.sessionId === 's1')).toHaveLength(2);
  });
});
