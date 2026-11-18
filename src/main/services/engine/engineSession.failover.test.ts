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
  /** The route each attempt was SENT on (GenerateInput.route). */
  routes: [] as (string | undefined)[],
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
// `crossProvider` simulates a resolver that WOULD move an Anthropic
// override to OpenAI once it is marked unavailable.
const dead = new Set<string>();
let crossProvider = false;
// `anthropicKeyGone`: the task resolves to OpenAI once the Anthropic key is
// removed (the chat provider falls back to the provider that has a key).
let anthropicKeyGone = false;
installTaskRouteResolver(() => {
  if (anthropicKeyGone) return { provider: 'openai', model: dead.has('gpt-6-luna') ? 'gpt-5-nano' : 'gpt-6-luna' };
  if (crossProvider)
    return dead.has('claude-opus-5-5')
      ? { provider: 'openai', model: 'gpt-6-luna' }
      : { provider: 'anthropic', model: 'claude-opus-5-5' };
  return { provider: 'openai', model: dead.has('gpt-6-luna') ? 'gpt-5-nano' : 'gpt-6-luna' };
});
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
  generate(input) {
    h.routes.push(input.route ? `${input.route.provider}/${input.route.model}` : undefined);
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
  crossProvider = false;
  anthropicKeyGone = false;
  h.routes.length = 0;
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

  it('never fails over to ANOTHER provider — interview data stays where the user sent it', async () => {
    crossProvider = true;
    attempt(async function* () {
      throw fail({ status: 404, code: 'model_not_found', message: 'model: claude-opus-5-5 not found' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'Answer sent to OpenAI without consent' };
    });
    await expect(
      session().answerQuestion('Tell me about yourself.', { type: 'resume_project', confidence: 1, strategy: '' }, null),
    ).rejects.toThrow(/claude-opus-5-5 not found/);
    expect(h.deltas).toEqual([]);
    expect(h.script).toHaveLength(1); // the OpenAI attempt never ran
    expect(h.errors.join(' ')).not.toMatch(/answering with/);
  });

  it('review: the key is removed mid-request — the failure is the route it was SENT on, and no retry moves provider', async () => {
    crossProvider = true; // starts on anthropic/claude-opus-5-5
    attempt(async function* () {
      anthropicKeyGone = true; // now the task resolves to OpenAI
      throw fail({ status: 404, code: 'model_not_found', message: 'model: claude-opus-5-5 not found' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'Answer sent to OpenAI without consent' };
    });
    await expect(
      session().answerQuestion('Tell me about yourself.', { type: 'resume_project', confidence: 1, strategy: '' }, null),
    ).rejects.toThrow(/claude-opus-5-5 not found/);
    expect(h.routes).toEqual(['anthropic/claude-opus-5-5']); // one attempt, on the captured route
    expect(dead.has('claude-opus-5-5')).toBe(true); // blamed: the model that failed
    expect(dead.has('gpt-6-luna')).toBe(false); // NOT the healthy route the task now resolves to
    expect(h.deltas).toEqual([]);
  });

  it('each attempt carries its route: the retry is sent on the fallback model explicitly', async () => {
    attempt(async function* () {
      throw fail({ status: 404, code: 'model_not_found', message: 'The model gpt-6-luna does not exist' });
    });
    attempt(async function* () {
      yield { type: 'delta', token: 'ok' };
    });
    await session().answerQuestion('Why this company?', { type: 'behavioral', confidence: 1, strategy: '' }, null);
    expect(h.routes).toEqual(['openai/gpt-6-luna', 'openai/gpt-5-nano']);
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
