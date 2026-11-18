import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bounded failover in the live answer path:
 *  - an unavailable model → the next candidate on the SAME provider, once
 *  - a transient network error before the first token → one retry
 *  - a partly streamed answer is never replayed
 *  - auth / quota errors surface (no retry)
 */
const h = vi.hoisted(() => ({
  errors: [] as string[],
  deltas: [] as string[],
  attempts: [] as string[],
  script: [] as (() => AsyncGenerator<{ type: 'delta'; token: string }>)[],
}));

vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, p: { message?: string }) => {
    if (ch.includes('error') && p?.message) h.errors.push(p.message);
  },
}));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: (_id: string, t: string) => h.deltas.push(t),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: vi.fn(),
  emitContributionOpen: vi.fn(),
  emitContributionReset: vi.fn(),
  emitContributionTitle: vi.fn(),
}));
vi.mock('../../providers/normalizeError', () => ({ normalizeProviderError: (e: Error) => e.message }));
vi.mock('../../db/repositories/profiles.repo', () => ({ profilesRepo: { get: () => ({ id: 'p1', name: 'T', language: 'en' }) } }));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../memory/recall', () => ({ recallMemories: async () => [] }));
vi.mock('./grounding', () => ({ ground: async () => [] }));
vi.mock('./persistence/enginePersistence', () => ({
  enginePersistence: {
    finalTranscript: () => 'tc1',
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
    insertQuestion: () => 'q1',
    replaceAnswer: vi.fn(),
    insertContribution: () => 'c1',
    setFollowup: vi.fn(),
    question: () => null,
    updateQuestionText: vi.fn(),
  },
}));

import { EngineSession } from './engineSession';
import { installTaskRouteResolver, installUnavailableMarker } from '../../providers/taskRoute';
import type { ModeDefinition } from './modeDefinition';

// A two-candidate "policy": luna until it is marked unavailable, then nano.
const dead = new Set<string>();
installTaskRouteResolver(() => ({ provider: 'openai', model: dead.has('gpt-6-luna') ? 'gpt-5-nano' : 'gpt-6-luna' }));
installUnavailableMarker((r) => dead.add(r.model));

const fail = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message)), o);

const mode: ModeDefinition = {
  id: 'interview',
  sources: ['ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: { evaluate: async () => ({ act: false, kind: null, reason: 'n/a' }) },
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  generate() {
    const next = h.script.shift();
    if (!next) throw new Error('no more scripted attempts');
    return next();
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

const attempt = (fn: () => AsyncGenerator<{ type: 'delta'; token: string }>) => h.script.push(fn);

beforeEach(() => {
  h.errors.length = 0;
  h.deltas.length = 0;
  h.script.length = 0;
  dead.clear();
});

describe('answer failover', () => {
  it('an unavailable model is skipped for the next candidate on the same provider', async () => {
    attempt(async function* () {
      throw fail({ status: 404, code: 'model_not_found', message: 'The model gpt-6-luna does not exist' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'Answer from the fallback model.' };
    });
    await session().answerQuestion('Tell me about yourself.', { type: 'resume_project', confidence: 1, strategy: '' }, null);
    expect(h.deltas).toEqual(['Answer from the fallback model.']);
    expect(dead.has('gpt-6-luna')).toBe(true);
    expect(h.errors.join(' ')).toMatch(/gpt-6-luna isn't available to your account — answering with gpt-5-nano/);
  });

  it('a transient network error before the first token is retried once', async () => {
    attempt(async function* () {
      throw fail({ code: 'ECONNRESET', message: 'socket hang up' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'ok' };
    });
    await session().answerQuestion('Why this company?', { type: 'behavioral', confidence: 1, strategy: '' }, null);
    expect(h.deltas).toEqual(['ok']);
  });

  it('never replays a partly streamed answer', async () => {
    attempt(async function* () {
      yield { type: 'delta', token: 'Half an ans' };
      throw fail({ code: 'ECONNRESET', message: 'socket hang up' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'DUPLICATE' };
    });
    await expect(
      session().answerQuestion('Why this company?', { type: 'behavioral', confidence: 1, strategy: '' }, null),
    ).rejects.toThrow(/socket hang up/);
    expect(h.deltas).toEqual(['Half an ans']);
    expect(h.script).toHaveLength(1); // the second attempt never ran
  });

  it('auth and quota errors surface without a retry', async () => {
    for (const e of [fail({ status: 401, message: 'Incorrect API key' }), fail({ status: 429, message: 'quota' })]) {
      h.script.length = 0;
      attempt(async function* () {
        throw e;
      });
      attempt(async function* () {
        yield { type: 'delta', token: 'should not run' };
      });
      await expect(session().answerQuestion('Q?', { type: 'behavioral', confidence: 1, strategy: '' }, null)).rejects.toThrow();
      expect(h.script).toHaveLength(1);
    }
    expect(h.errors).toEqual(expect.arrayContaining(['Incorrect API key', 'quota']));
  });

  it('retries at most once', async () => {
    for (let i = 0; i < 3; i++)
      attempt(async function* () {
        throw fail({ code: 'ETIMEDOUT', message: 'timeout' });
      });
    await expect(session().answerQuestion('Q?', { type: 'behavioral', confidence: 1, strategy: '' }, null)).rejects.toThrow();
    expect(h.script).toHaveLength(1); // two of three attempts consumed
  });
});
