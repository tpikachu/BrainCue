/**
 * Cloud model providers and the models a user can pick from.
 *
 * OpenAI stays the reference provider (embeddings, realtime STT, TTS and
 * vision fallbacks all still run there). The `chat` and `vision` capabilities
 * can be pointed at another provider PER TASK: a task override in
 * `AppSettings.models` may now be a qualified id — `anthropic/claude-fable-5-1`
 * — and a bare id keeps meaning OpenAI, so every stored setting from before
 * this file still resolves the same way.
 *
 * Three transport kinds cover every provider here:
 *  - `openai`            the OpenAI SDK against api.openai.com (Responses API)
 *  - `anthropic`         the Anthropic SDK (Messages API)
 *  - `openai-compatible` the OpenAI SDK with a different baseURL and key
 *                        (Google, Groq, OpenRouter all publish this surface)
 *
 * Keys live in main only (`services/security/providerKeys.ts`), encrypted at
 * rest, never sent to the renderer — the renderer learns `providerKeys[id]`
 * as a boolean and nothing else, the same rule the OpenAI key has always had.
 *
 * Model ids in the catalog are the vendors' documented ids as of 2026-09-06.
 * Verify against each vendor's live model list at release; the picker also
 * accepts a free-typed id for OpenRouter, whose catalog changes weekly.
 */

export type CloudProviderId = 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter';

export type ProviderTransport = 'openai' | 'anthropic' | 'openai-compatible';

export interface CloudProviderInfo {
  id: CloudProviderId;
  name: string;
  transport: ProviderTransport;
  /** For `openai-compatible` transports: the OpenAI-shaped base URL. */
  baseUrl?: string;
  /** Where a user gets a key. Shown next to the key field and in the picker. */
  keyUrl: string;
  /** What the key usually starts with — for a gentle "this doesn't look right" hint only. */
  keyPrefix?: string;
  /** Capabilities this provider can serve on this app's seam. */
  capabilities: ReadonlyArray<'chat' | 'vision'>;
  /** Accept a model id that isn't in the catalog (OpenRouter's list is unbounded). */
  freeformModels?: boolean;
}

export const CLOUD_PROVIDERS: CloudProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    transport: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    capabilities: ['chat', 'vision'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    transport: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    capabilities: ['chat', 'vision'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    transport: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyUrl: 'https://aistudio.google.com/apikey',
    capabilities: ['chat', 'vision'],
  },
  {
    id: 'groq',
    name: 'Groq',
    transport: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    capabilities: ['chat'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    transport: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-',
    capabilities: ['chat', 'vision'],
    freeformModels: true,
  },
];

export function cloudProvider(id: string): CloudProviderInfo | undefined {
  return CLOUD_PROVIDERS.find((p) => p.id === id);
}

/** Which app tasks a model is a sensible pick for. `answer` is the live cue
 *  (latency matters), `coding` is the solver (quality matters). */
export type ModelUse = 'answer' | 'coding' | 'classify' | 'parsing' | 'tailor' | 'mock';

export interface ModelOption {
  /** Bare vendor id, e.g. `claude-fable-5-1`. */
  id: string;
  provider: CloudProviderId;
  name: string;
  description: string;
  /** Tasks this model is offered for in pickers. Empty = offered for all chat tasks. */
  bestFor: ReadonlyArray<ModelUse>;
  /** Hidden reasoning before the answer — slower first token, better on hard problems. */
  reasoning?: boolean;
  /** Accepts image input (the coding screenshot path). */
  vision?: boolean;
}

export const MODEL_CATALOG: ModelOption[] = [
  // OpenAI — descriptions match the existing preset rationale in models.ts.
  { id: 'gpt-5', provider: 'openai', name: 'GPT-5', description: 'Strongest OpenAI reasoning model', bestFor: ['coding', 'tailor'], reasoning: true, vision: true },
  { id: 'gpt-5-mini', provider: 'openai', name: 'GPT-5 Mini', description: 'Fast reasoning, cost-efficient', bestFor: ['coding'], reasoning: true, vision: true },
  { id: 'gpt-5-nano', provider: 'openai', name: 'GPT-5 Nano', description: 'Ultra-fast, low latency', bestFor: ['classify'], reasoning: true },
  { id: 'gpt-4.1', provider: 'openai', name: 'GPT-4.1', description: 'Strong baseline, 1M context', bestFor: ['answer', 'parsing', 'tailor', 'mock'], vision: true },
  { id: 'gpt-4.1-mini', provider: 'openai', name: 'GPT-4.1 Mini', description: 'Smaller GPT-4.1 — the default live cue', bestFor: ['answer', 'parsing', 'mock'], vision: true },
  { id: 'gpt-4.1-nano', provider: 'openai', name: 'GPT-4.1 Nano', description: 'Lowest latency GPT-4.1', bestFor: ['classify'] },
  // Anthropic — Fable is the top tier; Opus 5 the default recommendation;
  // Sonnet/Haiku for the live paths where first-token time matters most.
  { id: 'claude-fable-5-1', provider: 'anthropic', name: 'Claude Fable 5.1', description: 'Most capable Anthropic model — hardest coding problems', bestFor: ['coding', 'tailor'], reasoning: true, vision: true },
  { id: 'claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5', description: 'Frontier quality with adaptive thinking', bestFor: ['coding', 'answer', 'tailor'], reasoning: true, vision: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', name: 'Claude Sonnet 5', description: 'Fast and strong — a good live cue', bestFor: ['answer', 'coding', 'parsing', 'mock'], reasoning: true, vision: true },
  { id: 'claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5', description: 'Lowest latency Claude', bestFor: ['answer', 'classify'], vision: true },
  // Google
  { id: 'gemini-2.5-pro', provider: 'google', name: 'Gemini 2.5 Pro', description: 'Google’s strongest reasoning model', bestFor: ['coding', 'tailor'], reasoning: true, vision: true },
  { id: 'gemini-2.5-flash', provider: 'google', name: 'Gemini 2.5 Flash', description: 'Fast, long context', bestFor: ['answer', 'parsing', 'mock'], vision: true },
  // Groq (hosted open models, very fast)
  { id: 'llama-3.3-70b-versatile', provider: 'groq', name: 'Llama 3.3 70B', description: 'Open model, very fast on Groq', bestFor: ['answer', 'mock'] },
  { id: 'openai/gpt-oss-120b', provider: 'groq', name: 'GPT-OSS 120B', description: 'Open-weight reasoning model on Groq', bestFor: ['coding', 'answer'], reasoning: true },
  // OpenRouter (any model id works; these are suggestions)
  { id: 'anthropic/claude-sonnet-5', provider: 'openrouter', name: 'Claude Sonnet 5 (via OpenRouter)', description: 'One key for many vendors', bestFor: ['answer', 'coding'], vision: true },
  { id: 'openai/gpt-5', provider: 'openrouter', name: 'GPT-5 (via OpenRouter)', description: 'One key for many vendors', bestFor: ['coding'], reasoning: true, vision: true },
];

/** `provider/model` — the form stored in `AppSettings.models` for non-OpenAI picks. */
export function qualifyModel(provider: CloudProviderId, modelId: string): string {
  return provider === 'openai' ? modelId : `${provider}/${modelId}`;
}

/** Split a stored model id. A bare id is OpenAI (every pre-existing setting).
 *  OpenRouter ids themselves contain a slash (`openai/gpt-5`), so only a
 *  KNOWN provider prefix is treated as one. */
export function parseModelId(stored: string): { provider: CloudProviderId; model: string } {
  const slash = stored.indexOf('/');
  if (slash > 0) {
    const prefix = stored.slice(0, slash);
    if (CLOUD_PROVIDERS.some((p) => p.id === prefix && p.id !== 'openai')) {
      return { provider: prefix as CloudProviderId, model: stored.slice(slash + 1) };
    }
  }
  return { provider: 'openai', model: stored };
}

export function modelOption(provider: CloudProviderId, modelId: string): ModelOption | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.id === modelId);
}

/** Display name for a stored id — catalog name when known, else the raw id. */
export function modelLabel(stored: string): string {
  const { provider, model } = parseModelId(stored);
  return modelOption(provider, model)?.name ?? model;
}
