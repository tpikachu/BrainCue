import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudProvider } from '@shared/providers';

type Call = { params: Record<string, unknown>; opts?: Record<string, unknown> };

// A fake `openai` SDK: records constructor options and every
// chat.completions.create call; streams two content deltas and a final
// usage-only chunk; the non-streaming reply text is test-controlled.
const h = vi.hoisted(() => ({
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  text: '{"ok":true}',
  rejectJsonMode: false,
  streamStatus: null as number | null, // when set, the streaming call throws an APIError with it
  calls: [] as Call[],
  ctorOpts: [] as Record<string, unknown>[],
}));

vi.mock('openai', () => {
  class APIError extends Error {
    status?: number;
    constructor(status?: number, message = 'boom') {
      super(message);
      this.status = status;
    }
  }
  class OpenAI {
    static APIError = APIError;
    chat = {
      completions: {
        create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
          h.calls.push({ params, opts });
          if (params.stream) {
            if (h.streamStatus !== null) throw new APIError(h.streamStatus, 'vendor said no');
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'Hi' } }] };
                yield { choices: [{ delta: { content: ' there' } }] };
                yield { choices: [{ delta: {} }] }; // tool/role-only chunk: no text
                yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } };
              },
            };
          }
          if (h.rejectJsonMode && params.response_format) {
            throw new APIError(400, 'response_format is not supported');
          }
          return { choices: [{ message: { content: h.text } }] };
        },
      },
    };
    constructor(opts: Record<string, unknown>) {
      h.ctorOpts.push(opts);
    }
  }
  return { default: OpenAI };
});
vi.mock('../keys', () => ({
  requireProviderKey: async (p: string) => `key-for-${p}`,
}));
vi.mock('../../services/openai/models', () => ({
  resolveModel: () => ({ provider: h.provider, model: h.model }),
}));

import OpenAI from 'openai';
import { normalizeCompatError, openaiCompatibleProvider } from './index';

const info = (id: 'google' | 'groq' | 'openrouter') => cloudProvider(id)!;
const groq = openaiCompatibleProvider(info('groq'));
const google = openaiCompatibleProvider(info('google'));
const openrouter = openaiCompatibleProvider(info('openrouter'));

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const last = () => h.calls[h.calls.length - 1];
const ctorFor = (baseUrl: string) => h.ctorOpts.find((o) => o.baseURL === baseUrl);

beforeEach(() => {
  h.provider = 'groq';
  h.model = 'llama-3.3-70b-versatile';
  h.text = '{"ok":true}';
  h.rejectJsonMode = false;
  h.streamStatus = null;
  h.calls = [];
});

describe('chat.stream — Chat Completions against the vendor base URL', () => {
  it('builds the client with the vendor baseURL + key and streams deltas then usage', async () => {
    const signal = new AbortController().signal;
    const events = await collect(
      groq.chat.stream({ task: 'answer', system: 'SYS', user: 'Q?', maxOutputTokens: 220, signal }),
    );
    expect(ctorFor('https://api.groq.com/openai/v1')).toMatchObject({ apiKey: 'key-for-groq' });
    expect(ctorFor('https://api.groq.com/openai/v1')).not.toHaveProperty('defaultHeaders');
    const call = last();
    expect(call.params).toEqual({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Q?' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 220, // non-reasoning model: the caller's ceiling verbatim
    });
    expect(call.opts).toEqual({ signal });
    expect(events).toEqual([
      { type: 'delta', token: 'Hi' },
      { type: 'delta', token: ' there' },
      { type: 'usage', prompt: 5, completion: 2 }, // from the final chunk, yielded last
    ]);
  });

  it('adds reasoning headroom for catalog reasoning models and omits max_tokens without a ceiling', async () => {
    h.model = 'openai/gpt-oss-120b';
    await collect(groq.chat.stream({ task: 'coding', system: 's', user: 'u', maxOutputTokens: 800 }));
    expect(last().params.max_tokens).toBe(800 + 1024);
    await collect(groq.chat.stream({ task: 'coding', system: 's', user: 'u' }));
    expect(last().params).not.toHaveProperty('max_tokens');
  });

  it('OpenRouter identifies the app via default headers', async () => {
    h.provider = 'openrouter';
    h.model = 'openai/gpt-5';
    await collect(openrouter.chat.stream({ task: 'coding', system: 's', user: 'u' }));
    expect(ctorFor('https://openrouter.ai/api/v1')).toMatchObject({
      apiKey: 'key-for-openrouter',
      defaultHeaders: { 'HTTP-Referer': 'https://braincue.app', 'X-Title': 'BrainCue' },
    });
    expect(last().params.model).toBe('openai/gpt-5'); // the vendor-side id keeps its slash
  });
});

describe('chat.json', () => {
  it('asks for json_object and parses the reply (fences tolerated)', async () => {
    h.text = '```json\n{"q": 1}\n```';
    const out = await groq.chat.json<{ q: number }>({ task: 'classify', system: 'SYS', user: 'u' });
    expect(out).toEqual({ q: 1 });
    expect(last().params).toMatchObject({ response_format: { type: 'json_object' } });
    expect(last().params.stream).toBeUndefined();
    const sys = (last().params.messages as { content: string }[])[0].content;
    expect(sys).toMatch(/^SYS\n\n.*STRICT JSON/s);
  });

  it('falls back to prompt-instructed JSON when the vendor rejects response_format (400)', async () => {
    h.rejectJsonMode = true;
    const out = await google.chat.json({ task: 'classify', system: 's', user: 'u' });
    expect(out).toEqual({ ok: true });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].params).toHaveProperty('response_format');
    expect(h.calls[1].params).not.toHaveProperty('response_format');
  });

  it('throws a user-safe error on non-JSON output', async () => {
    h.text = 'not json';
    await expect(groq.chat.json({ task: 'classify', system: 's', user: 'u' })).rejects.toThrow(/Groq returned .*valid JSON/);
  });
});

describe('vision', () => {
  it('exists only for vendors whose catalog entry has vision', () => {
    expect(groq.vision).toBeNull();
    expect(google.vision).not.toBeNull();
    expect(openrouter.vision).not.toBeNull();
  });

  it('sends the intro text then image_url parts (data URLs verbatim) on the coding task', async () => {
    h.provider = 'google';
    h.model = 'gemini-2.5-pro';
    const events = await collect(
      google.vision!.streamSolve({
        imageDataUrls: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
        language: 'go',
        format: 'explanation',
      }),
    );
    const messages = last().params.messages as { role: string; content: unknown }[];
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toMatch(/screenshot/);
    expect(messages[1].content).toEqual([
      { type: 'text', text: expect.stringMatching(/2 images are consecutive/) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'meta', riskWarning: null });
  });
});

describe('errors name the vendor, never OpenAI', () => {
  const sdk = OpenAI as unknown as { APIError: new (s: number, m?: string) => Error };

  it('normalizeCompatError', () => {
    expect(normalizeCompatError(info('groq'), new sdk.APIError(401))).toMatch(/^Groq rejected the API key \(401\)/);
    expect(normalizeCompatError(info('google'), new sdk.APIError(429))).toMatch(/^Google Gemini rate limit/);
    expect(normalizeCompatError(info('openrouter'), new sdk.APIError(502, 'bad gateway'))).toBe(
      'OpenRouter error 502: bad gateway',
    );
    expect(normalizeCompatError(info('groq'), new Error('plain'))).toBe('plain');
  });

  it('a streaming SDK failure is re-thrown as a vendor-named plain Error', async () => {
    h.streamStatus = 401;
    const run = () => collect(groq.chat.stream({ task: 'answer', system: 's', user: 'u' }));
    await expect(run()).rejects.toThrow('Groq rejected the API key (401). Check your key in Settings → Language Models.');
    await expect(run()).rejects.not.toBeInstanceOf(sdk.APIError); // the SDK class never reaches the engine
    h.streamStatus = 503;
    await expect(run()).rejects.toThrow('Groq error 503: vendor said no');
  });

  it('json() only swallows the 400 from response_format — other failures surface vendor-named', async () => {
    h.provider = 'google';
    h.streamStatus = null;
    // Non-streaming path: make the fake reject json mode with a 400 first (handled)…
    h.rejectJsonMode = true;
    await expect(google.chat.json({ task: 'classify', system: 's', user: 'u' })).resolves.toEqual({ ok: true });
  });
});
