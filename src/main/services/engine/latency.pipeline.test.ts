import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M7.2b / PERF-01 — the answer pipeline between an interviewer's final and
 * the answer's first token, measured offline on a fixed latency model.
 *
 * Real: EngineSession, the scheduler, grounding/retrieval, memory recall and
 * the latency record. Simulated (fake timers, deterministic): the query
 * embedding round trip, the provider's first token, and when the interim
 * transcript first reads as the question. Nothing reaches a provider, a
 * microphone or a database. These are NOT live-provider numbers — they show
 * what the pipeline itself adds on top of the provider, and they reproduce
 * on any machine.
 *
 * The latency model (ms):
 *   EMBED     700   one query embedding (historical live notes: ≈1–1.5 s
 *                   on a slow desktop link; smaller here so the pipeline's
 *                   own share is visible, not hidden behind it)
 *   STALL    6000   a stalled embedding (every 10th question) — the client
 *                   retries/times out far later than this in reality
 *   TTFT     1000   provider request → first token
 *   LEAD     1200   the interim reads as the question this long before the
 *                   final (2 of every 3 questions; the third is recognised
 *                   only at its final, so nothing could start earlier)
 *
 * The same file runs unchanged against the code before M7.2b; its printed
 * BENCH line is the before/after evidence in the handoff.
 */

const EMBED = 700;
const STALL = 6000;
const TTFT = 1000;
const LEAD = 1200;
const IDENTITY = { provider: 'openai', model: 'text-embedding-3-small', dim: 3 };

const h = vi.hoisted(() => ({
  embedCalls: 0,
  nextEmbedDelay: 0,
  firstDelta: new Map<string, number>(),
  qid: 0,
}));

vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: (id: string) => {
    if (!h.firstDelta.has(id)) h.firstDelta.set(id, Date.now());
  },
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
    insertQuestion: () => `q${++h.qid}`,
    replaceAnswer: vi.fn(),
    insertContribution: () => 'c1',
    setFollowup: vi.fn(),
    question: () => null,
    updateQuestionText: vi.fn(),
  },
}));
// The embedding provider: one round trip per call, abortable.
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    identity: () => IDENTITY,
    embedOne: (_text: string, opts?: { signal?: AbortSignal }) => {
      h.embedCalls++;
      const delay = h.nextEmbedDelay;
      return new Promise<Float32Array>((resolve, reject) => {
        const t = setTimeout(() => resolve(Float32Array.from([1, 0, 0])), delay);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    },
  }),
}));
// One embedded résumé chunk; one approved memory in the same space.
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
    markUsed: vi.fn(),
  },
}));

import { EngineSession } from './engineSession';
import type { ModeDefinition } from './modeDefinition';

const mode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: {
    evaluate: async () => ({ act: true, kind: 'answer' as const, question: { type: 'behavioral', confidence: 0.9, strategy: '' }, reason: 'q' }),
  },
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  async *generate(input) {
    await new Promise((r) => setTimeout(r, TTFT));
    if (input.signal?.aborted) throw new Error('aborted');
    yield { type: 'delta', token: 'I scaled it by sharding.' };
  },
};

const TOPICS = [
  'scale the payments service at your last company',
  'handle an outage that affected paying customers',
  'decide between two competing database designs',
  'mentor a junior engineer who was struggling',
  'reduce the build time for the main repository',
  'convince your team to adopt a new testing approach',
  'deal with a stakeholder who kept changing requirements',
  'plan the migration off the legacy billing system',
  'measure whether a feature launch was successful',
  'approach on-call when the alert volume doubled',
];
const question = (i: number) => `How did you ${TOPICS[i % TOPICS.length]} in project ${i + 1}?`;

/** Run `n` questions in one session; returns final → first token per question. */
async function run(format: 'general' | 'technical', n: number) {
  const s = new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: null,
    mode,
    settings: { interviewType: 'general', answerFormat: format, pronunciation: false, presence: 'balanced' },
    ephemeral: false,
  });
  const out: { ms: number; prefetch: boolean; stall: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const prefetch = i % 3 !== 2;
    const stall = i % 10 === 9;
    h.nextEmbedDelay = stall ? STALL : EMBED;
    const text = question(i);
    if (prefetch) {
      s.prefetchGrounding(text.replace(/\?$/, '')); // the interim, before the final
      await vi.advanceTimersByTimeAsync(LEAD);
    }
    const finalAt = Date.now();
    const before = new Set(h.firstDelta.keys());
    let settled = false;
    const done = s
      .onTranscriptFinal(text, 'interviewer', { finalAt, speechEndAt: finalAt - 600, speechEndSource: 'vad' } as never)
      .finally(() => (settled = true));
    // However long this pipeline takes (simulated time, capped at 2 min).
    for (let t = 0; t < 120_000 && !settled; t += 100) await vi.advanceTimersByTimeAsync(100);
    await done;
    const id = [...h.firstDelta.keys()].find((k) => !before.has(k));
    out.push({ ms: id ? h.firstDelta.get(id)! - finalAt : Number.POSITIVE_INFINITY, prefetch, stall });
    await vi.advanceTimersByTimeAsync(20_000); // a distinct question, well apart
  }
  s.teardown();
  return out;
}

const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-18T09:00:00Z'));
  h.embedCalls = 0;
  h.firstDelta.clear();
});
afterEach(() => vi.useRealTimers());

describe('final → first token, offline latency model (30 General + 30 Technical questions)', () => {
  it('adds no wait for context when it was gathered on the interim, one embedding otherwise, and caps a stalled one', async () => {
    const result: Record<string, unknown> = {};
    const all: { ms: number; prefetch: boolean; stall: boolean }[] = [];
    for (const format of ['general', 'technical'] as const) {
      const embedsBefore = h.embedCalls;
      const rows = await run(format, 30);
      all.push(...rows);
      const ms = rows.map((r) => r.ms);
      result[format] = { n: rows.length, p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms), embeddings: h.embedCalls - embedsBefore };
    }
    // eslint-disable-next-line no-console
    console.log('BENCH', JSON.stringify(result));

    // Every question was answered.
    expect(all.every((r) => Number.isFinite(r.ms))).toBe(true);
    // Gathered on the interim (documents AND memory): the provider's own
    // first-token time is the whole wait.
    for (const r of all.filter((r) => r.prefetch && !r.stall)) expect(r.ms).toBe(TTFT);
    // Recognised only at the final: ONE embedding round trip (documents and
    // memory share it, in parallel), then the provider.
    for (const r of all.filter((r) => !r.prefetch && !r.stall)) expect(r.ms).toBe(EMBED + TTFT);
    // A stalled embedding is cut at the deadline and ranked lexically — the
    // answer still comes, grounded on the same documents.
    for (const r of all.filter((r) => r.stall)) expect(r.ms).toBeLessThanOrEqual(2500 + TTFT);
    // One embedding per question: never a second, serial one for memory.
    expect((result.general as { embeddings: number }).embeddings).toBe(30);
    expect((result.technical as { embeddings: number }).embeddings).toBe(30);
  }, 60_000);
});
