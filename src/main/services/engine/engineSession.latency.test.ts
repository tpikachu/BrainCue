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
}));

vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: vi.fn(),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: vi.fn(),
  emitContributionOpen: vi.fn(),
  emitContributionReset: vi.fn(),
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
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
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
  settingsRepo: { get: (k: string) => (k === 'memory_enabled' ? '1' : null) },
}));
vi.mock('../../db/repositories/jobs.repo', () => ({ contextPacksRepo: { get: () => null } }));
vi.mock('../../db/repositories/memories.repo', () => ({
  memoriesRepo: {
    recallRows: () => [
      {
        id: 'm1',
        category: 'fact',
        content: 'Prefers to lead with the payments migration.',
        importance: 0.5,
        updatedAt: 0,
        lastUsedAt: null,
        embedProvider: 'openai',
        embedModel: 'text-embedding-3-small',
        embedDim: 3,
        embedVector: Buffer.from(Float32Array.from([1, 0, 0]).buffer),
      },
    ],
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
    packId: null,
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
    latency.mark(id, { firstUsefulAt: finalAt + TTFT + 30 }); // the overlay's paint report

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
