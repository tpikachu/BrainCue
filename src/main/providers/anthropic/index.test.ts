import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = {
  surface: 'messages' | 'beta';
  method: 'stream' | 'create';
  params: Record<string, unknown>;
  opts?: Record<string, unknown>;
};

// A fake `@anthropic-ai/sdk`: records every request, replays a fixed stream
// (two text deltas, one thinking delta that must be ignored) and a final
// message whose stop_reason / text the test controls.
const h = vi.hoisted(() => ({
  model: 'claude-opus-5',
  effortOverride: null as string | null,
  stopReason: 'end_turn',
  text: '{"ok":true}',
  calls: [] as Call[],
  ctorOpts: [] as Record<string, unknown>[],
}));

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
    constructor(status?: number, message = 'boom') {
      super(message);
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {
    constructor() {
      super(401, 'invalid x-api-key');
    }
  }
  class RateLimitError extends APIError {
    constructor() {
      super(429, 'rate limited');
    }
  }
  const final = () => ({
    stop_reason: h.stopReason,
    usage: { input_tokens: 12, output_tokens: 7 },
    content: [{ type: 'text', text: h.text }],
  });
  const stream =
    (surface: Call['surface']) => (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      h.calls.push({ surface, method: 'stream', params, opts });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start' };
          yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } };
          yield { type: 'message_stop' };
        },
        finalMessage: async () => final(),
      };
    };
  const create =
    (surface: Call['surface']) => async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      h.calls.push({ surface, method: 'create', params, opts });
      return final();
    };
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    messages = { stream: stream('messages'), create: create('messages') };
    beta = { messages: { stream: stream('beta'), create: create('beta') } };
    constructor(opts: Record<string, unknown>) {
      h.ctorOpts.push(opts);
    }
  }
  return { default: Anthropic };
});
vi.mock('../keys', () => ({
  requireProviderKey: async () => 'sk-ant-test-key-1234',
}));
vi.mock('../../services/openai/models', () => ({
  resolveModel: () => ({ provider: 'anthropic', model: h.model }),
  reasoningEffortOverride: () => h.effortOverride,
}));
vi.mock('../../services/openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
}));

import Anthropic from '@anthropic-ai/sdk';
import { anthropicChat, anthropicVision, imageBlockFromDataUrl } from './index';
import { normalizeProviderError } from '../normalizeError';
import type { ChatStreamEvent } from '../types';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const last = () => h.calls[h.calls.length - 1];

beforeEach(() => {
  h.model = 'claude-opus-5';
  h.effortOverride = null;
  h.stopReason = 'end_turn';
  h.text = '{"ok":true}';
  h.calls = [];
});

describe('anthropicChat.stream — request shaping', () => {
  it('opus-5 on a live task: no thinking param, effort low, max_tokens = ceiling + headroom', async () => {
    const signal = new AbortController().signal;
    const events = await collect(
      anthropicChat.stream({ task: 'answer', system: 'SYS', user: 'Q?', maxOutputTokens: 220, signal }),
    );
    const call = last();
    expect(call.surface).toBe('messages'); // fallbacks are a Fable opt-in only
    expect(call.method).toBe('stream');
    expect(call.params).not.toHaveProperty('thinking');
    expect(call.params).not.toHaveProperty('temperature');
    expect(call.params).not.toHaveProperty('top_p');
    expect(call.params).toMatchObject({
      model: 'claude-opus-5',
      system: 'SYS',
      messages: [{ role: 'user', content: 'Q?' }],
      max_tokens: 220 + 1024,
      output_config: { effort: 'low' },
    });
    expect(call.opts).toEqual({ signal }); // abort passes through as a request option
    // Text deltas in order (thinking deltas ignored), usage LAST.
    expect(events).toEqual([
      { type: 'delta', token: 'Hel' },
      { type: 'delta', token: 'lo' },
      { type: 'usage', prompt: 12, completion: 7 },
    ] satisfies ChatStreamEvent[]);
  });

  it('client is built once from the stored key (cached per key fingerprint)', async () => {
    await collect(anthropicChat.stream({ task: 'answer', system: 's', user: 'u' }));
    await collect(anthropicChat.stream({ task: 'answer', system: 's', user: 'u' }));
    expect(h.ctorOpts).toHaveLength(1);
    expect(h.ctorOpts[0]).toMatchObject({ apiKey: 'sk-ant-test-key-1234' });
  });

  it('fable-5-1 on coding: beta surface + server-side fallbacks, effort high, no thinking', async () => {
    h.model = 'claude-fable-5-1';
    await collect(anthropicChat.stream({ task: 'coding', system: 's', user: 'u' }));
    const call = last();
    expect(call.surface).toBe('beta');
    expect(call.params).not.toHaveProperty('thinking');
    expect(call.params).toMatchObject({
      model: 'claude-fable-5-1',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high' },
      max_tokens: 4096 + 1024, // default ceiling + reasoning headroom
    });
  });

  it('coding/tailor follow the user’s effort override (minimal→low, medium, high)', async () => {
    for (const [stored, expected] of [
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
    ] as const) {
      h.effortOverride = stored;
      await collect(anthropicChat.stream({ task: 'tailor', system: 's', user: 'u' }));
      expect(last().params.output_config, stored).toEqual({ effort: expected });
    }
    // …but the live paths ignore the override and stay at low.
    h.effortOverride = 'high';
    await collect(anthropicChat.stream({ task: 'classify', system: 's', user: 'u' }));
    expect(last().params.output_config).toEqual({ effort: 'low' });
  });

  it('haiku-4-5: neither thinking nor effort, and no reasoning headroom', async () => {
    h.model = 'claude-haiku-4-5';
    await collect(anthropicChat.stream({ task: 'coding', system: 's', user: 'u', maxOutputTokens: 500 }));
    const call = last();
    expect(call.surface).toBe('messages');
    expect(call.params).not.toHaveProperty('thinking');
    expect(call.params).not.toHaveProperty('output_config');
    expect(call.params.max_tokens).toBe(500);
  });

  it('a refusal stop reason throws a user-safe error after the stream', async () => {
    h.stopReason = 'refusal';
    await expect(
      collect(anthropicChat.stream({ task: 'answer', system: 's', user: 'u' })),
    ).rejects.toThrow('The model declined this request.');
  });
});

describe('anthropicChat.json', () => {
  it('is a non-streaming create with a strict-JSON instruction, parsing a fenced reply', async () => {
    h.text = '```json\n{"question": true, "topic": "db"}\n```';
    const out = await anthropicChat.json<{ question: boolean }>({ task: 'classify', system: 'SYS', user: 'u' });
    const call = last();
    expect(call.method).toBe('create');
    expect(String(call.params.system)).toMatch(/^SYS\n\n.*STRICT JSON/s);
    expect(call.params.output_config).toEqual({ effort: 'low' });
    expect(out).toEqual({ question: true, topic: 'db' });
  });

  it('uses the beta surface with fallbacks for Fable', async () => {
    h.model = 'claude-fable-5-1';
    await anthropicChat.json({ task: 'parsing', system: 's', user: 'u' });
    expect(last().surface).toBe('beta');
    expect(last().params).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
  });

  it('throws on non-JSON output and on refusal', async () => {
    h.text = 'Sorry, here is prose.';
    await expect(anthropicChat.json({ task: 'classify', system: 's', user: 'u' })).rejects.toThrow(/valid JSON/);
    h.text = '{}';
    h.stopReason = 'refusal';
    await expect(anthropicChat.json({ task: 'classify', system: 's', user: 'u' })).rejects.toThrow(/declined/);
  });
});

describe('anthropicVision.streamSolve', () => {
  it('sends base64 image blocks (in scroll order) then the text prompt, on the coding task', async () => {
    const events = await collect(
      anthropicVision.streamSolve({
        imageDataUrls: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
        language: 'python',
        format: 'general',
      }),
    );
    const call = last();
    const content = (call.params.messages as { content: unknown[] }[])[0].content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      { type: 'text', text: expect.stringMatching(/2 images are consecutive/) },
    ]);
    expect(String(call.params.system)).toMatch(/screenshot/);
    expect(String(call.params.system)).toMatch(/python/);
    expect(call.params.output_config).toEqual({ effort: 'high' });
    expect(events.at(-1)).toEqual({ type: 'meta', riskWarning: null });
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(2);
  });

  it('rejects an image it cannot describe as a base64 block', () => {
    expect(() => imageBlockFromDataUrl('https://example.com/x.png')).toThrow(/Unsupported screenshot/);
    expect(imageBlockFromDataUrl('data:image/jpg;base64,Q').source).toMatchObject({ media_type: 'image/jpeg' });
  });
});

describe('normalizeProviderError', () => {
  type Ctor = new () => Error;
  const sdk = Anthropic as unknown as { AuthenticationError: Ctor; RateLimitError: Ctor; APIError: new (s: number, m: string) => Error };

  it('maps Anthropic SDK errors to user-safe messages and leaves others to the OpenAI normalizer', () => {
    expect(normalizeProviderError(new sdk.AuthenticationError())).toMatch(/Anthropic rejected the API key \(401\)/);
    expect(normalizeProviderError(new sdk.RateLimitError())).toMatch(/Anthropic rate limit.*429/);
    expect(normalizeProviderError(new sdk.APIError(529, 'overloaded'))).toBe('Anthropic error 529: overloaded');
    expect(normalizeProviderError(new Error('Groq needs an API key'))).toBe('Groq needs an API key');
  });
});
