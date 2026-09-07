import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The registry loads every adapter. Stub what they reach for at load or on
// first use: the settings DB (per-task overrides live there — the REAL
// models.ts runs on top of this stub, so routing is exercised end-to-end),
// the OpenAI client/realtime modules, and the per-provider key store (every
// non-OpenAI adapter resolves its key lazily through it).
const state = vi.hoisted(() => ({
  models: {} as Record<string, string>,
  keys: {} as Record<string, string>,
}));

vi.mock('../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { modelPreset: 'model_preset', models: 'models', reasoningEfforts: 'reasoning_efforts' },
  settingsRepo: {
    get: () => null,
    getJson: (k: string, fallback: unknown) => (k === 'models' ? state.models : fallback),
  },
}));
vi.mock('../services/openai/client', () => ({
  openai: () => {
    throw new Error('network disabled in tests');
  },
  normalizeOpenAIError: (e: unknown) => String(e),
}));
vi.mock('../services/openai/realtime', () => ({
  RealtimeTranscriber: class {
    start() {}
    appendAudio() {}
    stop() {}
  },
}));
vi.mock('../services/security/providerKeys', () => ({
  providerKeys: { getDecrypted: (p: string) => state.keys[p] ?? null },
}));

import { providerFor, providerSelection, registerProvider, setProviderSelection } from './registry';
import { CapabilityUnavailableError } from './errors';
import type { ChatJsonRequest, ChatProvider, ChatStreamEvent, VisionProvider } from './types';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function fakeChat(tag: string, seen: unknown[]): ChatProvider {
  return {
    async *stream(req): AsyncGenerator<ChatStreamEvent> {
      seen.push(req);
      yield { type: 'delta', token: tag };
      yield { type: 'usage', prompt: 1, completion: 1 };
    },
    async json<T>(req: ChatJsonRequest): Promise<T> {
      seen.push(req);
      return { from: tag } as T;
    },
  };
}

beforeEach(() => {
  state.models = {};
  state.keys = {};
});

afterEach(() => {
  setProviderSelection('chat', 'routed');
  setProviderSelection('vision', 'routed');
});

describe('routed chat — dispatch follows the task model', () => {
  it('chat and vision select the routed implementation by default', () => {
    expect(providerSelection('chat')).toBe('routed');
    expect(providerSelection('vision')).toBe('routed');
    expect(providerSelection('embedding')).toBe('openai');
    expect(providerSelection('realtimeStt')).toBe('openai');
  });

  it('a bare (or absent) override reaches the OpenAI adapter — the pre-existing path', async () => {
    await expect(
      collect(providerFor('chat').stream({ task: 'answer', system: 's', user: 'u' })),
    ).rejects.toThrow(/network disabled/);
    state.models = { answer: 'gpt-4o' };
    await expect(
      collect(providerFor('chat').stream({ task: 'answer', system: 's', user: 'u' })),
    ).rejects.toThrow(/network disabled/);
  });

  it('a qualified override dispatches THAT task to the provider adapter, others stay on OpenAI', async () => {
    const seen: unknown[] = [];
    registerProvider('anthropic', 'chat', fakeChat('claude', seen));
    state.models = { coding: 'anthropic/claude-opus-5' };

    const req = { task: 'coding' as const, system: 'sys', user: 'solve', maxOutputTokens: 900 };
    expect(await collect(providerFor('chat').stream(req))).toEqual([
      { type: 'delta', token: 'claude' },
      { type: 'usage', prompt: 1, completion: 1 },
    ]);
    expect(seen[0]).toEqual(req); // the request passes through untouched
    expect(await providerFor('chat').json({ task: 'coding', system: 's', user: 'u' })).toEqual({
      from: 'claude',
    });
    // The live cue is still OpenAI.
    await expect(
      collect(providerFor('chat').stream({ task: 'answer', system: 's', user: 'u' })),
    ).rejects.toThrow(/network disabled/);
  });

  it('routes each task independently across providers', async () => {
    const seen: unknown[] = [];
    registerProvider('google', 'chat', fakeChat('gemini', seen));
    registerProvider('groq', 'chat', fakeChat('groq', seen));
    state.models = { answer: 'google/gemini-2.5-flash', classify: 'groq/llama-3.3-70b-versatile' };
    expect(await providerFor('chat').json({ task: 'answer', system: 's', user: 'u' })).toEqual({ from: 'gemini' });
    expect(await providerFor('chat').json({ task: 'classify', system: 's', user: 'u' })).toEqual({ from: 'groq' });
  });

  it('a provider without a stored key fails with the Settings hint (never a bare SDK error)', async () => {
    state.models = { tailor: 'openrouter/openai/gpt-5' };
    await expect(
      collect(providerFor('chat').stream({ task: 'tailor', system: 's', user: 'u' })),
    ).rejects.toThrow('OpenRouter needs an API key — add one in Settings → Language Models.');
    await expect(providerFor('chat').json({ task: 'tailor', system: 's', user: 'u' })).rejects.toThrow(
      /OpenRouter needs an API key/,
    );
  });
});

describe('routed vision — follows the coding task', () => {
  const input = { imageDataUrls: ['data:image/png;base64,AAAA'], language: 'python', format: 'explanation' as const };

  it('dispatches to the coding model’s provider', async () => {
    const seen: unknown[] = [];
    const fakeVision: VisionProvider = {
      async *streamSolve(i) {
        seen.push(i);
        yield { type: 'delta', token: 'img' };
        yield { type: 'meta', riskWarning: null };
      },
    };
    registerProvider('anthropic', 'vision', fakeVision);
    state.models = { coding: 'anthropic/claude-sonnet-5' };
    expect(await collect(providerFor('vision').streamSolve(input))).toEqual([
      { type: 'delta', token: 'img' },
      { type: 'meta', riskWarning: null },
    ]);
    expect(seen[0]).toBe(input);
  });

  it('a provider with no vision (Groq) is a clear capability gap naming the fix', async () => {
    state.models = { coding: 'groq/llama-3.3-70b-versatile' };
    const run = () => collect(providerFor('vision').streamSolve(input));
    await expect(run()).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(run()).rejects.toThrow(/Groq can't read screenshots.*Settings → Language Models/);
  });
});
