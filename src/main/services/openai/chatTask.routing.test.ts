import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M2 — provider selection that stays consistent.
 *
 * Review finding: provider-aware selection broke the callers that still went
 * straight to the OpenAI SDK with `model(task)`. With Anthropic selected, the
 * session report sent a Claude model id to OpenAI (or failed on the missing
 * OpenAI key); parsing, briefs, stories and practice had the same mismatch.
 *
 * The REAL models.ts + policy + registry + routed provider + readiness run
 * here on a stubbed settings/key store; only the vendor adapters are faked,
 * and each fake records which provider AND model a request reached. Covered:
 * single-provider (non-OpenAI) and multiple-key configurations, per-task
 * overrides (valid, unavailable, keyless), unavailable models, partial
 * streams, and the per-feature readiness gates.
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  models: {} as Record<string, string>,
  seen: [] as { provider: string; model: string; task: string }[],
  /** Scripted outcome per call, in order; default 'ok'. */
  script: [] as ('ok' | 'model' | 'auth' | 'partial')[],
  openaiSdkCalls: 0,
  /** When set, every request waits here before it resolves or fails — so a
   *  test can hold requests in flight and interleave their failures. */
  gate: null as Promise<void> | null,
  /** Runs while a request is in flight (e.g. remove a key mid-request). */
  during: null as (() => void) | null,
}));

vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: {
    modelPreset: 'model_preset',
    models: 'models',
    reasoningEfforts: 'reasoning_efforts',
    chatProvider: 'chat_provider',
    modelDiscovery: 'model_discovery',
    apiKeyPresent: 'openai_api_key_present',
    providerKeyPresent: (p: string) => `provider_key_present:${p}`,
  },
  settingsRepo: {
    get: (k: string) => state.settings[k] ?? null,
    getJson: (k: string, fallback: unknown) => (k === 'models' ? state.models : fallback),
  },
}));
vi.mock('./client', () => ({
  openai: () => {
    state.openaiSdkCalls++;
    throw new Error('the OpenAI SDK must not be called here');
  },
  normalizeOpenAIError: (e: unknown) => String(e),
}));
vi.mock('./realtime', () => ({ RealtimeTranscriber: class {} }));
const keyOf = (p: string) => (p === 'openai' ? 'openai_api_key_present' : `provider_key_present:${p}`);
vi.mock('../security/providerKeys', () => ({
  providerKeys: {
    getDecrypted: () => 'k',
    isPresent: (p: string) => state.settings[keyOf(p)] === '1',
    presence: () =>
      Object.fromEntries(['openai', 'anthropic', 'google', 'groq', 'openrouter'].map((p) => [p, state.settings[keyOf(p)] === '1'])),
  },
}));
vi.mock('../stt', () => ({ readSttPrefs: () => ({ engine: 'local' }), sttReady: () => true }));
vi.mock('../../db/repositories/sessions.repo', () => ({
  sessionsRepo: {
    detail: () => ({ kind: 'live', transcript: [{ speaker: 'interviewer', text: 'Tell me about yourself.' }], questions: [] }),
    saveReport: (r: unknown) => r,
  },
}));
vi.mock('../mock/sparringManager', () => ({ buildSparringReport: () => null }));

import { registerProvider } from '../../providers/registry';
import { taskRoute } from '../../providers/taskRoute';
import type { ChatProvider } from '../../providers/types';
import { generateReport } from '../session/report';
import { parseResume } from './parsing';
import { generateQuestion } from './interviewer';
import { evaluateAnswer } from './feedback';
import { openaiOnlyModel, resetRuntimeAvailability } from './models';
import { tailorApplication } from './tailor';
import { classifyQuestion } from './questions';
import { featureReadiness } from '../readiness';
import { PROVIDER_PLANS } from '@shared/modelPolicy';
import type { Profile } from '@shared/types';

const fail = (kind: 'model' | 'auth') =>
  Object.assign(new Error(kind === 'model' ? 'The model does not exist' : 'Incorrect API key'), {
    status: kind === 'model' ? 404 : 401,
    ...(kind === 'model' ? { code: 'model_not_found' } : {}),
  });

/** Like a real adapter: the model is the one the request CARRIES (its
 *  captured route), else whatever the task resolves to at dispatch. */
function fake(provider: string): ChatProvider {
  const record = (req: { task: string; route?: { model: string } }) => {
    state.seen.push({ provider, model: req.route?.model ?? taskRoute(req.task as never)?.model ?? '?', task: req.task });
    return state.script.shift() ?? 'ok';
  };
  const settle = async () => {
    state.during?.();
    if (state.gate) await state.gate;
  };
  return {
    async *stream(req) {
      const outcome = record(req);
      await settle();
      if (outcome === 'model' || outcome === 'auth') throw fail(outcome);
      yield { type: 'delta', token: 'Next question?' };
      if (outcome === 'partial') throw fail('model'); // dies after a token
    },
    async json<T>(req: { task: string; route?: { model: string } }): Promise<T> {
      const outcome = record(req);
      await settle();
      if (outcome === 'model' || outcome === 'auth') throw fail(outcome);
      return {} as T;
    },
  };
}
for (const p of ['openai', 'anthropic', 'google']) registerProvider(p, 'chat', fake(p));

const profile = { id: 'p1', name: 'T', language: 'en', parsedResume: null } as unknown as Profile;
const providers = () => [...new Set(state.seen.map((s) => s.provider))];

/** Keys present, plus the chat provider (null = never chosen). */
function configure(keys: string[], chatProvider: string | null) {
  state.settings = Object.fromEntries(keys.map((p) => [keyOf(p), '1']));
  if (chatProvider) state.settings.chat_provider = chatProvider;
}

beforeEach(() => {
  state.seen.length = 0;
  state.script.length = 0;
  state.openaiSdkCalls = 0;
  state.gate = null;
  state.during = null;
  state.models = {};
  resetRuntimeAvailability();
  configure(['openai', 'anthropic'], 'anthropic');
});

describe('latency-tolerant features follow the selected provider', () => {
  it('multiple keys, Anthropic chosen: report, parsing, mock questions and sparring feedback all run on Anthropic', async () => {
    await generateReport('s1');
    await parseResume('Jane Doe, SWE');
    await generateQuestion(profile, []);
    await evaluateAnswer({ profile, job: null, interviewType: 'general', question: 'Q?', answer: 'A.' } as never);
    expect(state.seen.map((s) => [s.provider, s.task])).toEqual([
      ['anthropic', 'answer'],
      ['anthropic', 'parsing'],
      ['anthropic', 'mock'],
      ['anthropic', 'mock'],
    ]);
    for (const s of state.seen) expect(s.model).toMatch(/^claude-/); // never an OpenAI id on Anthropic
    expect(state.openaiSdkCalls).toBe(0);
  });

  it('Anthropic ONLY (no OpenAI key): the same features work, with no OpenAI request', async () => {
    configure(['anthropic'], null);
    await generateReport('s1');
    await parseResume('Jane Doe, SWE');
    expect(providers()).toEqual(['anthropic']);
    expect(state.openaiSdkCalls).toBe(0);
  });

  it('multiple keys, OpenAI chosen: they run on OpenAI, as before', async () => {
    configure(['openai', 'anthropic'], 'openai');
    await generateReport('s1');
    expect(state.seen).toEqual([{ provider: 'openai', model: expect.stringMatching(/^gpt-/), task: 'answer' }]);
  });
});

describe('per-task overrides never move data to another provider', () => {
  it('an override on another provider is honoured', async () => {
    configure(['openai', 'anthropic', 'google'], 'openai');
    state.models = { parsing: 'google/gemini-3-flash' };
    await parseResume('x');
    expect(state.seen[0]).toMatchObject({ provider: 'google', task: 'parsing' });
  });

  it('an override whose model is unavailable retries on the SAME provider — never the chat provider', async () => {
    configure(['openai', 'anthropic'], 'openai');
    state.models = { answer: 'anthropic/claude-opus-5-5' };
    state.script = ['model', 'ok'];
    await generateReport('s1');
    expect(providers()).toEqual(['anthropic']);
    expect(state.seen.map((s) => s.model)).toEqual(['claude-opus-5-5', expect.not.stringMatching(/^claude-opus-5-5$/)]);
    expect(state.openaiSdkCalls).toBe(0);
  });

  it('an override whose provider has NO key is not moved elsewhere; readiness names the fix', async () => {
    configure(['openai'], 'openai');
    state.models = { parsing: 'anthropic/claude-sonnet-5-5' };
    await parseResume('x'); // reaches the Anthropic adapter, which fails "needs an API key" in reality
    expect(providers()).toEqual(['anthropic']);
    const f = featureReadiness();
    expect(f.parsing.ready).toBe(false);
    expect(f.parsing.problem).toMatch(/override uses Anthropic, which has no API key/);
  });
});

describe('unavailable models and partial streams', () => {
  it('a model the account lacks is marked and retried ONCE on the next candidate of the same provider', async () => {
    configure(['openai'], 'openai');
    state.script = ['model', 'ok'];
    await parseResume('x');
    expect(state.seen).toHaveLength(2);
    expect(state.seen[0].model).not.toBe(state.seen[1].model);
    expect(providers()).toEqual(['openai']);
    // Remembered: the next call goes straight to the fallback.
    state.seen.length = 0;
    await parseResume('y');
    expect(state.seen).toHaveLength(1);
  });

  it('at most one retry', async () => {
    configure(['openai'], 'openai');
    state.script = ['model', 'model', 'ok'];
    await expect(parseResume('x')).rejects.toThrow(/does not exist/);
    expect(state.seen).toHaveLength(2);
  });

  it('auth errors are not retried', async () => {
    state.script = ['auth', 'ok'];
    await expect(generateReport('s1')).rejects.toThrow(/Incorrect API key/);
    expect(state.seen).toHaveLength(1);
  });

  it('a text stream that fails AFTER its first token is not replayed', async () => {
    state.script = ['partial', 'ok'];
    await expect(generateQuestion(profile, [])).rejects.toThrow();
    expect(state.seen).toHaveLength(1);
  });

  it('a text stream that fails BEFORE its first token on a model error retries once (same provider)', async () => {
    configure(['openai', 'anthropic'], 'openai'); // OpenAI's mock plan has a second candidate
    state.script = ['model', 'ok'];
    await expect(generateQuestion(profile, [])).resolves.toBe('Next question?');
    expect(state.seen).toHaveLength(2);
    expect(providers()).toEqual(['openai']);
  });

  it('with no further candidate on that provider, the error surfaces — nothing moves to another provider', async () => {
    // Anthropic's mock plan has ONE model; OpenAI also has a key here.
    state.script = ['model', 'ok'];
    await expect(generateQuestion(profile, [])).rejects.toThrow(/does not exist/);
    expect(state.seen).toHaveLength(1);
    expect(providers()).toEqual(['anthropic']);
  });
});

describe('OpenAI-only features and the per-feature gates', () => {
  it('tailoring asks OpenAI for an OpenAI model, never another provider’s id', () => {
    const m = openaiOnlyModel('tailor');
    expect(PROVIDER_PLANS.openai.balanced.tailor).toContain(m);
    expect(m).not.toMatch(/claude/);
  });

  it('without an OpenAI key, tailoring refuses up front, naming why', async () => {
    configure(['anthropic'], 'anthropic');
    await expect(tailorApplication({ baseResume: 'x', jdText: 'y', questions: [] })).rejects.toThrow(/OpenAI only/);
    expect(state.openaiSdkCalls).toBe(0);
  });

  it('feature readiness: Anthropic only → parsing ready; mock, sparring and tailoring gated with the reason', () => {
    configure(['anthropic'], null);
    const f = featureReadiness();
    expect(f.parsing).toEqual({ ready: true });
    expect(f.mock.ready).toBe(false);
    expect(f.mock.problem).toMatch(/speak through OpenAI/);
    expect(f.sparring.ready).toBe(false);
    expect(f.sparring.problem).toMatch(/speaks and listens through OpenAI/);
    expect(f.tailoring.ready).toBe(false);
  });

  it('feature readiness: both keys → everything ready', () => {
    const f = featureReadiness();
    expect([f.parsing.ready, f.mock.ready, f.sparring.ready, f.tailoring.ready]).toEqual([true, true, true, true]);
  });

  it('review: mock also needs its ANSWER model — a keyless answer override blocks Mock, not Sparring', () => {
    configure(['openai'], 'openai');
    state.models = { answer: 'anthropic/claude-sonnet-5-5' };
    const f = featureReadiness();
    expect(f.mock.ready).toBe(false);
    expect(f.mock.problem).toMatch(/answer model override uses Anthropic, which has no API key.*answer cues in a mock interview/);
    expect(f.sparring).toEqual({ ready: true }); // sparring writes no answer cues
  });
});

describe('review: failures are attributed to the route the request was SENT on', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('the key is removed mid-request: the retry does NOT move to the provider the task now resolves to', async () => {
    configure(['openai', 'anthropic'], 'anthropic');
    state.script = ['model', 'ok'];
    // While the Anthropic request is in flight the Anthropic key disappears,
    // so the task now resolves to OpenAI.
    state.during = () => {
      delete state.settings[keyOf('anthropic')];
      state.during = null;
    };
    await expect(parseResume('x')).rejects.toThrow(/does not exist/);
    expect(state.seen.map((r) => r.provider)).toEqual(['anthropic']); // no OpenAI retry
    expect(state.openaiSdkCalls).toBe(0);
  });

  it('two concurrent failures on one model mark THAT model only — the healthy fallback stays usable', async () => {
    configure(['openai'], 'openai');
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    state.script = ['model', 'model', 'ok', 'ok'];
    const a = parseResume('a');
    const b = parseResume('b');
    await tick(); // both in flight on the first candidate
    const first = state.seen[0].model;
    expect(state.seen.map((r) => r.model)).toEqual([first, first]);
    release();
    await Promise.all([a, b]);
    const fallback = state.seen[2].model;
    expect(fallback).not.toBe(first);
    // Both retries went to the fallback, and it is still the task's route —
    // the second failure did not mark it (old code: blamed the CURRENT route).
    expect(state.seen.map((r) => r.model)).toEqual([first, first, fallback, fallback]);
    expect(taskRoute('parsing')?.model).toBe(fallback);
  });

  it('concurrent classifier failures do the same (detection runs classifications concurrently)', async () => {
    configure(['openai'], 'openai');
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    state.script = ['model', 'model'];
    const first = taskRoute('classify')!.model;
    const a = classifyQuestion('So, what about the migration').catch(() => {});
    const b = classifyQuestion('And the rollback plan').catch(() => {});
    await tick();
    release();
    await Promise.all([a, b]);
    const candidates = PROVIDER_PLANS.openai.balanced.classify;
    expect(first).toBe(candidates[0]);
    expect(taskRoute('classify')?.model).toBe(candidates[1]); // not candidates[2]
  });
});
