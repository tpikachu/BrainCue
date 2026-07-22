import { afterEach, describe, expect, it, vi } from 'vitest';

// Loading the registry loads the OpenAI reference impls, which import
// client/models — stub those so no DB (models → settings → better-sqlite3)
// or network is touched. Capability methods that would hit the SDK throw.
vi.mock('../services/openai/client', () => ({
  openai: () => {
    throw new Error('network disabled in tests');
  },
  normalizeOpenAIError: (e: unknown) => String(e),
}));
vi.mock('../services/openai/models', () => ({
  model: (k: string) => `model:${k}`,
  isReasoningModel: () => false,
  reasoningEffort: () => null,
  EMBEDDING_DIM: 1536,
}));
vi.mock('../services/openai/realtime', () => ({
  RealtimeTranscriber: class {
    start() {}
    appendAudio() {}
    stop() {}
  },
}));

import { providerFor, registerProvider, setProviderSelection } from './registry';
import { CapabilityUnavailableError } from './errors';
import { streamAnswer, type AnswerEvent } from '../services/openai/answer';
import type { Capability, ChatProvider } from './types';

const ALL: Capability[] = ['chat', 'embedding', 'realtimeStt', 'batchStt', 'speech', 'vision'];

afterEach(() => {
  for (const c of ALL) setProviderSelection(c, 'openai'); // never leak selection between tests
});

describe('provider registry', () => {
  it('resolves the OpenAI reference implementation for every capability', () => {
    for (const c of ALL) expect(providerFor(c)).toBeDefined();
  });

  it('reports the embedding identity from the model config', () => {
    expect(providerFor('embedding').identity()).toEqual({
      provider: 'openai',
      model: 'model:embedding',
      dim: 1536,
    });
  });

  it('a capability gap fails with a clear, user-safe error', () => {
    setProviderSelection('speech', 'acme');
    expect(() => providerFor('speech')).toThrowError(CapabilityUnavailableError);
    expect(() => providerFor('speech')).toThrow(/voice output.*'acme'.*Settings/s);
  });
});

describe('the generation seam runs against a fake provider', () => {
  it('streamAnswer flows end-to-end through a registered fake ChatProvider', async () => {
    let seen: { task: string; system: string; user: string; maxOutputTokens?: number } | null =
      null;
    const fake: ChatProvider = {
      // eslint-disable-next-line require-yield
      async *stream(req) {
        seen = req;
        yield { type: 'delta', token: 'Fake ' };
        yield { type: 'delta', token: 'answer' };
        yield { type: 'usage', prompt: 3, completion: 2 };
      },
      async json<T>(): Promise<T> {
        throw new Error('not used');
      },
    };
    registerProvider('fake', 'chat', fake);
    setProviderSelection('chat', 'fake');

    const events: AnswerEvent[] = [];
    for await (const ev of streamAnswer({
      question: 'Why us?',
      contextChunks: [{ id: 'c1', sourceType: 'resume', content: 'x', score: 0.9 }],
      profile: { targetRole: 'SWE', targetCompany: 'Acme' } as never,
      format: 'key_points',
      pronunciation: false,
      interviewType: 'behavioral',
    })) {
      events.push(ev);
    }

    // Domain stays in answer.ts (prompt building, ceilings, meta); transport
    // came from the fake — the seam works without any OpenAI code in the path.
    expect(events).toEqual([
      { type: 'delta', token: 'Fake ' },
      { type: 'delta', token: 'answer' },
      { type: 'usage', prompt: 3, completion: 2 },
      { type: 'meta', riskWarning: null },
    ]);
    expect(seen!.task).toBe('answer');
    expect(seen!.system).toContain('You ARE the candidate');
    expect(seen!.user).toContain('QUESTION: Why us?');
    expect(seen!.maxOutputTokens).toBe(220); // key_points ceiling, no pronunciation headroom
  });
});
