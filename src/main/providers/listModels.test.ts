import { describe, expect, it, vi } from 'vitest';

/**
 * The vendor `/models` lists mix chat models with embeddings, speech, image
 * and legacy completion models. Only chat-capable ids may reach the per-task
 * picker — offering a TTS voice as the live cue would fail at first use.
 */
vi.mock('../services/openai/models', () => ({
  resolveModel: () => ({ provider: 'openai', model: 'gpt-4.1-mini' }),
  reasoningEffortOverride: () => undefined,
}));
vi.mock('./keys', () => ({
  requireProviderKey: async () => 'test-key-1234',
}));
vi.mock('../services/openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
  listModels: async () => [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-5',
    'gpt-5-2025-08-07',
    'gpt-4o-2024-11-20',
    'o4-mini',
    'sora-2',
    'text-embedding-3-small',
    'gpt-4o-mini-tts',
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-realtime-preview',
    'omni-moderation-latest',
    'dall-e-3',
    'gpt-image-1',
    'gpt-4o-audio-preview',
    'davinci-002',
    'babbage-002',
    'gpt-3.5-turbo-instruct',
    'computer-use-preview',
    'gpt-4o-search-preview',
    'codex-mini-latest',
  ],
}));
vi.mock('./anthropic/client', () => ({
  anthropicClient: async () => ({
    models: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          yield { id: 'claude-sonnet-5' };
          yield { id: 'claude-opus-5' };
          yield { id: 'claude-fable-5-1' };
        },
      }),
    },
  }),
}));
vi.mock('./openaiCompatible/client', () => ({
  compatClient: async (info: { id: string }) => ({
    models: {
      list: async () => ({
        data:
          info.id === 'groq'
            ? [
                { id: 'llama-3.3-70b-versatile' },
                { id: 'whisper-large-v3' },
                { id: 'distil-whisper-large-v3-en' },
                { id: 'playai-tts' },
                { id: 'llama-guard-4-12b' },
                { id: 'openai/gpt-oss-120b' },
              ]
            : [{ id: 'gemini-2.5-pro' }, { id: 'text-embedding-004' }, { id: 'imagen-4.0' }, { id: 'veo-3' }],
      }),
    },
  }),
}));

import { isChatModelId, listProviderModels } from './listModels';

describe('listProviderModels', () => {
  it('OpenAI: keeps chat models, drops embeddings/speech/image/video/moderation/legacy and dated twins, sorts', async () => {
    // gpt-5-2025-08-07 duplicates gpt-5 and goes; gpt-4o-2024-11-20 has no alias here and stays.
    expect(await listProviderModels('openai')).toEqual(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-2024-11-20', 'gpt-5', 'o4-mini']);
  });

  it('Anthropic: walks the paginated list', async () => {
    expect(await listProviderModels('anthropic')).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('OpenAI-compatible vendors: same filter on their /models', async () => {
    expect(await listProviderModels('groq')).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
    expect(await listProviderModels('google')).toEqual(['gemini-2.5-pro']);
  });

  it('isChatModelId keeps ordinary ids and Gemini flash', () => {
    expect(isChatModelId('gemini-2.5-flash')).toBe(true);
    expect(isChatModelId('claude-haiku-4-5')).toBe(true);
    expect(isChatModelId('mistralai/mistral-large')).toBe(true);
    expect(isChatModelId('text-embedding-3-large')).toBe(false);
  });
});
