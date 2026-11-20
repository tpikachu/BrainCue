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
 * Model ids in the catalog are the vendors' documented ids as of 2026-11-17
 * (sources in docs/06-OPENAI-SERVICE.md), with explicit capability metadata —
 * reasoning efforts, thinking control, latency class, lifecycle — so code
 * never has to guess from a model's name. Discovery (the vendor's model
 * list, cached) decides what an account can actually use; the picker also
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
  /** Reasoning-effort values the model accepts, lowest first. Absent on a
   *  reasoning model = the vendor's own defaults (low/medium/high). */
  efforts?: readonly string[];
  /** Anthropic: thinking can be disabled for the live paths. */
  disableThinking?: boolean;
  /** Rough first-token class, for the picker and the policy explanation. */
  latency?: 'low' | 'medium' | 'high';
  /** Lifecycle on the vendor's deprecations page. Absent = current. */
  status?: 'current' | 'deprecated' | 'retired';
  /** Vendor shutdown date (ISO), when announced. */
  shutdown?: string;
}

export const MODEL_CATALOG: ModelOption[] = [
  // OpenAI — verified 2026-11-17 on developers.openai.com/api/docs/models and
  // against an account's live GET /v1/models. `efforts` lists what
  // reasoning.effort accepts, lowest first ("none" = no hidden reasoning).
  { id: 'gpt-6-luna', provider: 'openai', name: 'GPT-6 Luna', description: 'Fastest current OpenAI model — the live cue and classifier', bestFor: ['answer', 'classify', 'parsing', 'mock'], reasoning: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], vision: true, latency: 'low' },
  { id: 'gpt-6.1-terra', provider: 'openai', name: 'GPT-6.1 Terra', description: 'Balanced quality — stronger live answers', bestFor: ['answer', 'coding', 'tailor', 'parsing', 'mock'], reasoning: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], vision: true, latency: 'medium' },
  { id: 'gpt-6.2-sol', provider: 'openai', name: 'GPT-6.2 Sol', description: 'Highest-quality answers; always reasons', bestFor: ['tailor', 'coding'], reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], vision: true, latency: 'high' },
  { id: 'gpt-6.2-astra', provider: 'openai', name: 'GPT-6.2 Astra', description: 'Deepest reasoning — the coding solver', bestFor: ['coding'], reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], vision: true, latency: 'high' },
  { id: 'gpt-5', provider: 'openai', name: 'GPT-5', description: 'Deprecated — shuts down 2026-12-11', bestFor: [], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, status: 'deprecated', shutdown: '2026-12-11' },
  { id: 'gpt-5-mini', provider: 'openai', name: 'GPT-5 Mini', description: 'Deprecated — shuts down 2026-12-11', bestFor: [], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, status: 'deprecated', shutdown: '2026-12-11' },
  { id: 'gpt-5-nano', provider: 'openai', name: 'GPT-5 Nano', description: 'Deprecated — shuts down 2026-12-11', bestFor: [], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], status: 'deprecated', shutdown: '2026-12-11' },
  { id: 'gpt-4.1', provider: 'openai', name: 'GPT-4.1', description: 'Deprecated — shuts down 2027-01-14', bestFor: [], vision: true, status: 'deprecated', shutdown: '2027-01-14' },
  { id: 'gpt-4.1-mini', provider: 'openai', name: 'GPT-4.1 Mini', description: 'Deprecated — shuts down 2027-01-14', bestFor: [], vision: true, status: 'deprecated', shutdown: '2027-01-14' },
  { id: 'gpt-4.1-nano', provider: 'openai', name: 'GPT-4.1 Nano', description: 'Retired 2026-10-23 — no longer served', bestFor: [], status: 'retired', shutdown: '2026-10-23' },
  // Anthropic — verified 2026-11-17 on platform.claude.com/docs (models
  // overview + effort). `disableThinking`: thinking can be switched off for
  // the live paths (Haiku 5.5 at effort ≤ high); the others think adaptively.
  { id: 'claude-haiku-5-5', provider: 'anthropic', name: 'Claude Haiku 5.5', description: 'Lowest latency Claude — the live cue and classifier', bestFor: ['answer', 'classify', 'parsing', 'mock'], reasoning: true, disableThinking: true, vision: true, latency: 'low' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', name: 'Claude Sonnet 5.5', description: 'Fast and strong — a balanced live cue', bestFor: ['answer', 'coding', 'parsing', 'mock', 'tailor'], reasoning: true, vision: true, latency: 'medium' },
  { id: 'claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5', description: 'Frontier quality with adaptive thinking', bestFor: ['answer', 'coding', 'tailor'], reasoning: true, vision: true, latency: 'high' },
  { id: 'claude-fable-5-2', provider: 'anthropic', name: 'Claude Fable 5.2', description: 'Most capable Claude — hardest coding problems', bestFor: ['coding', 'tailor'], reasoning: true, vision: true, latency: 'high' },
  { id: 'claude-fable-5-1', provider: 'anthropic', name: 'Claude Fable 5.1', description: 'Superseded by Fable 5.2', bestFor: [], reasoning: true, vision: true, status: 'deprecated' },
  { id: 'claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5', description: 'Superseded by Opus 5.5', bestFor: [], reasoning: true, vision: true, status: 'deprecated' },
  { id: 'claude-sonnet-5', provider: 'anthropic', name: 'Claude Sonnet 5', description: 'Superseded by Sonnet 5.5', bestFor: [], reasoning: true, vision: true, status: 'deprecated' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5', description: 'Past its retirement date — may be withdrawn', bestFor: [], vision: true, status: 'deprecated' },
  // Google — verified 2026-11-17 on aistudio.google.com/docs/models. Reasoning
  // cannot be turned off on Gemini 3+/4; "minimal" is the lowest effort.
  { id: 'gemini-3.5-flash-lite', provider: 'google', name: 'Gemini 3.5 Flash-Lite', description: 'Fastest stable Gemini', bestFor: ['answer', 'classify', 'parsing', 'mock'], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, latency: 'low' },
  { id: 'gemini-3.8-flash', provider: 'google', name: 'Gemini 3.8 Flash', description: 'Balanced stable Gemini', bestFor: ['answer', 'coding', 'parsing', 'mock', 'tailor'], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, latency: 'medium' },
  { id: 'gemini-4-argon', provider: 'google', name: 'Gemini 4 Argon', description: 'Quality Flash-class model (stability not stated)', bestFor: ['answer', 'tailor'], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, latency: 'medium' },
  { id: 'gemini-4-carbon', provider: 'google', name: 'Gemini 4 Carbon', description: 'Deep reasoning (stability not stated)', bestFor: ['coding'], reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'], vision: true, latency: 'high' },
  { id: 'gemini-2.5-pro', provider: 'google', name: 'Gemini 2.5 Pro', description: 'Deprecated — rerouted from 2026-12-01', bestFor: [], reasoning: true, vision: true, status: 'deprecated', shutdown: '2026-12-01' },
  { id: 'gemini-2.5-flash', provider: 'google', name: 'Gemini 2.5 Flash', description: 'Deprecated — rerouted from 2026-12-01', bestFor: [], vision: true, status: 'deprecated', shutdown: '2026-12-01' },
  // Groq — verified 2026-11-17 on console.groq.com/docs/models (production).
  { id: 'openai/gpt-oss-20b', provider: 'groq', name: 'GPT-OSS 20B', description: 'Open-weight, very fast on Groq', bestFor: ['answer', 'classify', 'parsing', 'mock'], reasoning: true, efforts: ['low', 'medium', 'high'], latency: 'low' },
  { id: 'openai/gpt-oss-120b', provider: 'groq', name: 'GPT-OSS 120B', description: 'Open-weight reasoning model on Groq', bestFor: ['coding', 'answer', 'tailor'], reasoning: true, efforts: ['low', 'medium', 'high'], latency: 'medium' },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', name: 'Llama 3.3 70B', description: 'On the deprecations list — may be gone for self-serve keys', bestFor: [], status: 'deprecated' },
  // OpenRouter (any model id works; these are suggestions — not verified).
  { id: 'anthropic/claude-sonnet-5-5', provider: 'openrouter', name: 'Claude Sonnet 5.5 (via OpenRouter)', description: 'One key for many vendors', bestFor: ['answer', 'coding'], vision: true },
  { id: 'openai/gpt-6-luna', provider: 'openrouter', name: 'GPT-6 Luna (via OpenRouter)', description: 'One key for many vendors', bestFor: ['answer', 'classify'], reasoning: true, vision: true },
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
