import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which provider and model actually RECEIVE each task (M7.2a, AI-01).
 *
 * The real routing policy (shared/modelPolicy.ts via models.ts), the real
 * routed chat/vision providers, the real interview mode, answer pipeline and
 * coding solver run on top of an in-memory settings table. Only the vendor
 * adapters are fakes: each records the task and the route of every request
 * it receives, so these tests read the truth at the adapter boundary — not
 * what a label or a latency seed claims.
 */

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** Every request an adapter received: "provider:kind:task → provider/model". */
  seen: [] as string[],
  /** Per provider, scripted behaviour for its next stream requests. */
  script: {} as Record<string, ((req: { route?: { model: string } }) => AsyncGenerator<{ type: 'delta'; token: string }>)[]>,
  metas: [] as Record<string, unknown>[],
  contexts: [] as Record<string, unknown>[],
  saved: [] as Record<string, unknown>[],
  logs: [] as string[],
  errors: [] as string[],
}));

vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: {
    apiKeyPresent: 'openai_api_key_present',
    models: 'models',
    modelPreset: 'model_preset',
    reasoningEfforts: 'reasoning_efforts',
    codingLanguage: 'coding_language',
    chatProvider: 'chat_provider',
    modelDiscovery: 'model_discovery',
    providerKeyPresent: (p: string) => `provider_key_present:${p}`,
  },
  settingsRepo: {
    get: (k: string) => h.store.get(k) ?? null,
    getJson: (k: string, fb: unknown) => (h.store.has(k) ? JSON.parse(h.store.get(k)!) : fb),
    set: (k: string, v: string) => h.store.set(k, v),
    setJson: (k: string, v: unknown) => h.store.set(k, JSON.stringify(v)),
    delete: (k: string) => h.store.delete(k),
  },
}));
// No network, no Electron, no key store: the adapters below are fakes.
vi.mock('../openai/client', () => ({
  openai: () => {
    throw new Error('network disabled in tests');
  },
  normalizeOpenAIError: (e: unknown) => String(e),
}));
vi.mock('../openai/realtime', () => ({ RealtimeTranscriber: class {} }));
vi.mock('../security/providerKeys', () => ({ providerKeys: { getDecrypted: () => null, isPresent: () => false } }));
vi.mock('electron', () => ({ clipboard: { readText: () => '' } }));
vi.mock('../../windows/overlayWindow', () => ({ showOverlay: vi.fn() }));
vi.mock('../session/sessionManager', () => ({ sessionManager: { activeAnswerFormat: () => 'general' } }));
vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, p: { message?: string }) => {
    if (ch.includes('error') && p?.message) h.errors.push(p.message);
  },
}));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: (_id: string, c: Record<string, unknown>) => h.contexts.push(c),
  emitContributionDelta: vi.fn(),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: (_id: string, m: Record<string, unknown>) => h.metas.push(m),
  emitContributionOpen: vi.fn(),
  emitContributionReset: vi.fn(),
  emitContributionTake: () => {},
  emitContributionTitle: vi.fn(),
}));
vi.mock('../../providers/normalizeError', () => ({ normalizeProviderError: (e: Error) => e.message }));
vi.mock('../../db/repositories/profiles.repo', () => ({
  profilesRepo: { get: () => ({ id: 'p1', name: 'T', language: 'en', targetRole: 'Engineer', targetCompany: 'Acme' }) },
}));
vi.mock('../security/logger', () => ({
  log: {
    info: (m: string) => h.logs.push(String(m)),
    warn: (m: string) => h.logs.push(String(m)),
    error: vi.fn(),
  },
}));
vi.mock('../memory/recall', () => ({ recallMemories: async () => [], markRecalled: () => {}, revalidateRecalled: (_p: string, _k: unknown, m: unknown) => m }));
vi.mock('./grounding', () => ({ ground: async () => [] }));
vi.mock('./persistence/enginePersistence', () => ({
  enginePersistence: {
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
    replaceAnswer: vi.fn(),
    insertContribution: (c: Record<string, unknown>) => {
      h.saved.push(c);
      return 'c1';
    },
    setFollowup: vi.fn(),
  },
}));

import { registerProvider } from '../../providers/registry';
import type { ChatProvider, ChatStreamEvent, VisionProvider } from '../../providers/types';
import { installKeyPresence, onRoutesChanged, resetRuntimeAvailability, resolveTask, resolveTaskAuto } from '../openai/models';
import { EngineSession } from './engineSession';
import { interviewMode } from './modes/interview.mode';
import { latency } from './metrics/latencyStore';
import { runCodingSolve, runCodingSolveFromImage } from '../capture/codingMode';

const routeOf = (req: { route?: { provider: string; model: string } }) => (req.route ? `${req.route.provider}/${req.route.model}` : 'UNPINNED');

function fakeChat(provider: string): ChatProvider {
  return {
    async *stream(req): AsyncGenerator<ChatStreamEvent> {
      h.seen.push(`${provider}:chat:${req.task} → ${routeOf(req)}`);
      const next = h.script[provider]?.shift();
      if (next) {
        yield* next(req);
        return;
      }
      yield { type: 'delta', token: 'An answer.' };
    },
    async json<T>(req: { task: string; route?: { provider: string; model: string } }): Promise<T> {
      h.seen.push(`${provider}:json:${req.task} → ${routeOf(req)}`);
      return { followup: '' } as T;
    },
  };
}
function fakeVision(provider: string): VisionProvider {
  return {
    async *streamSolve(input) {
      h.seen.push(`${provider}:vision:coding → ${routeOf(input)}`);
      yield { type: 'delta', token: 'A solution.' };
      yield { type: 'meta', riskWarning: null };
    },
  };
}
for (const p of ['openai', 'anthropic']) {
  registerProvider(p, 'chat', fakeChat(p));
  registerProvider(p, 'vision', fakeVision(p));
}
installKeyPresence(() => ({ openai: true, anthropic: true }));

const modelNotFound = (model: string) =>
  Object.assign(new Error(`The model ${model} does not exist`), { status: 404, code: 'model_not_found' });

const session = () =>
  new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: null,
    mode: interviewMode,
    settings: { interviewType: 'general', answerFormat: 'general', pronunciation: false, presence: 'balanced' },
    ephemeral: true, // no follow-up prediction: only the answer request is under test
  });

const setModels = (m: Record<string, string>) => h.store.set('models', JSON.stringify(m));
const streams = () => h.seen.filter((s) => s.includes(':chat:') || s.includes(':vision:'));

beforeEach(() => {
  h.store.clear();
  h.seen.length = 0;
  h.metas.length = 0;
  h.contexts.length = 0;
  h.saved.length = 0;
  h.logs.length = 0;
  h.errors.length = 0;
  for (const k of Object.keys(h.script)) delete h.script[k];
  resetRuntimeAvailability();
  // The reported configuration: Anthropic chosen for chat, Balanced, and a
  // coding-only override on OpenAI (Cue Card settings → Coding solver).
  h.store.set('chat_provider', 'anthropic');
  setModels({ coding: 'gpt-6.2-astra' });
});

describe('each task reaches the provider and model the policy chose', () => {
  it('a General answer and the coding solver go to different, separately chosen routes', async () => {
    await session().generateContribution('q1', 'Tell me about a project you led.');
    await runCodingSolve('Reverse a linked list.');
    await runCodingSolveFromImage('data:image/png;base64,AAAA');

    expect(streams()).toEqual([
      'anthropic:chat:answer → anthropic/claude-sonnet-5-5', // Anthropic · Balanced pick
      'openai:chat:coding → openai/gpt-6.2-astra', // the coding override, on its own provider
      'openai:vision:coding → openai/gpt-6.2-astra', // the screenshot solver follows it
    ]);
    // What the UI is told agrees with what each adapter received…
    expect(h.contexts[0]).toMatchObject({ sentTo: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    const answeredBy = h.metas.map((m) => m.answeredBy);
    expect(answeredBy).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { provider: 'openai', model: 'gpt-6.2-astra' },
      { provider: 'openai', model: 'gpt-6.2-astra' },
    ]);
    // …and the saved answer keeps its own route.
    expect(h.saved[0].meta).toMatchObject({ answeredBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    // The coding override does not touch the answer, and Automatic would name
    // the provider's own pick (what the Cue Card's "Automatic —" row shows).
    expect(resolveTask('answer')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'policy' });
    expect(resolveTaskAuto('coding')).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('diagnostic logs name provider/model per attempt and never the question or a key', async () => {
    await session().generateContribution('q1', 'What is your SECRET-QUESTION-TEXT?');
    const routeLogs = h.logs.filter((l) => /answer (attempt|served)/.test(l));
    expect(routeLogs).toEqual(['answer attempt 1 → anthropic/claude-sonnet-5-5', 'answer served by anthropic/claude-sonnet-5-5']);
    expect(h.logs.join('\n')).not.toMatch(/SECRET-QUESTION-TEXT|sk-/);
  });
});

describe('an in-flight request stays pinned; a change applies to the next one', () => {
  it('changing the answer model and provider mid-stream does not move or relabel the answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.script.anthropic = [
      async function* () {
        yield { type: 'delta', token: 'First words… ' };
        await gate;
        yield { type: 'delta', token: 'the rest.' };
      },
    ];
    const s = session();
    const first = s.generateContribution('q1', 'Why this company?');
    await vi.waitFor(() => expect(streams()).toHaveLength(1));
    // While it streams: the user picks OpenAI for answers.
    setModels({ coding: 'gpt-6.2-astra', answer: 'gpt-6-luna' });
    release();
    await first;
    expect(h.metas.at(-1)?.answeredBy).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });

    await s.generateContribution('q2', 'And your weaknesses?');
    expect(streams()).toEqual([
      'anthropic:chat:answer → anthropic/claude-sonnet-5-5',
      'openai:chat:answer → openai/gpt-6-luna', // the NEXT question uses the new pick
    ]);
    expect(h.metas.at(-1)?.answeredBy).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
  });
});

describe('same-provider failover: every attempt, the answering route, and the relabel signal', () => {
  it('records the failed attempt, names the model that answered, and tells the windows the route moved', async () => {
    let routesChanged = 0;
    const off = onRoutesChanged(() => routesChanged++);
    h.script.anthropic = [
      // eslint-disable-next-line require-yield
      async function* (req) {
        throw modelNotFound(req.route!.model);
      },
    ];
    // What answerScheduled seeds at dispatch, before any attempt.
    const take = latency.begin({ questionId: 'qf', sessionId: 's1', finalAt: Date.now(), provider: 'anthropic', model: 'claude-sonnet-5-5' });

    await session().generateContribution('qf', 'Walk me through your last role.', undefined, { take });
    off();

    expect(streams()).toEqual([
      'anthropic:chat:answer → anthropic/claude-sonnet-5-5',
      'anthropic:chat:answer → anthropic/claude-haiku-5-5', // next candidate, SAME provider
    ]);
    expect(h.metas.at(-1)?.answeredBy).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      failed: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', reason: 'model' }],
    });
    expect(h.saved[0].meta).toMatchObject({ answeredBy: { model: 'claude-haiku-5-5' } });
    // The latency record names the attempt that answered, not the dispatch seed.
    expect(latency.get('qf')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', failedAttempts: 1 });
    // The next request's route moved — and every window is told.
    expect(routesChanged).toBe(1);
    expect(resolveTask('answer')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(h.logs.filter((l) => /answer (attempt|served)/.test(l))).toEqual([
      'answer attempt 1 → anthropic/claude-sonnet-5-5',
      'answer attempt 2 → anthropic/claude-haiku-5-5',
      'answer served by anthropic/claude-haiku-5-5 after 1 failed attempt(s)',
    ]);
  });

  it('never fails over to another provider, and retries at most once', async () => {
    setModels({ answer: 'anthropic/claude-opus-5-5' }); // an explicit Anthropic override
    h.script.anthropic = [
      // eslint-disable-next-line require-yield
      async function* (req) {
        throw modelNotFound(req.route!.model);
      },
      // eslint-disable-next-line require-yield
      async function* (req) {
        throw modelNotFound(req.route!.model);
      },
    ];
    await expect(session().generateContribution('q1', 'Tell me about yourself.')).rejects.toThrow(/does not exist/);
    expect(streams().every((s) => s.startsWith('anthropic:'))).toBe(true);
    expect(streams()).toHaveLength(2);
  });
});
