import { cloudProvider, modelOption, parseModelId, qualifyModel, type CloudProviderId } from './providers';

/**
 * Model selection a normal user never has to think about
 * (docs/06-OPENAI-SERVICE.md §Model selection).
 *
 * The user picks a PROVIDER and a PREFERENCE — Fast, Balanced or Quality —
 * and every chat task gets a suitable model on that provider:
 *
 *   classify   high-frequency "is this a question?" — lowest latency, JSON
 *   answer     the live cue — fast first token; quality grows with preference
 *   parsing    one-off résumé/JD parsing and context maintenance
 *   coding     the coding solver — where deeper reasoning earns its latency
 *   mock/tailor practice and résumé tailoring
 *
 * Each task holds an ORDERED candidate list per provider and preference. The
 * first candidate the account can actually use wins: discovery (the
 * provider's own model list, cached off the hot path) filters the list, and a
 * model that failed as unavailable at runtime is skipped. Per-task overrides
 * from Advanced settings still win — unless they cannot run (no key for
 * their provider, or not served to the account), in which case the policy
 * pick is used and the reason is reported.
 *
 * Candidate ids were verified on 2026-11-17 against each vendor's model
 * documentation, and the OpenAI ones against the live model list of a real
 * account (see docs/06 for the table and sources). Ids are data, not
 * contracts: discovery keeps a stale list from breaking anything.
 */

export type ModelPreference = 'fast' | 'balanced' | 'quality';
export const MODEL_PREFERENCES: ModelPreference[] = ['fast', 'balanced', 'quality'];

export type PolicyTask = 'classify' | 'answer' | 'parsing' | 'coding' | 'mock' | 'tailor';
export const POLICY_TASKS: PolicyTask[] = ['classify', 'answer', 'parsing', 'coding', 'mock', 'tailor'];

/** Tasks on the live interview path: always the lowest reasoning effort the
 *  model accepts (none where it exists) — first-token latency is the product. */
export const LIVE_TASKS: ReadonlySet<string> = new Set(['classify', 'answer', 'mock']);

type Plan = Record<PolicyTask, string[]>;

const OPENAI: Record<ModelPreference, Plan> = {
  fast: {
    classify: ['gpt-6-luna', 'gpt-5-nano', 'gpt-4.1-mini'],
    answer: ['gpt-6-luna', 'gpt-4.1-mini'],
    parsing: ['gpt-6-luna', 'gpt-4.1-mini'],
    coding: ['gpt-6.1-terra', 'gpt-5-mini'],
    mock: ['gpt-6-luna', 'gpt-4.1-mini'],
    tailor: ['gpt-6.1-terra', 'gpt-4.1'],
  },
  balanced: {
    classify: ['gpt-6-luna', 'gpt-5-nano', 'gpt-4.1-mini'],
    answer: ['gpt-6-luna', 'gpt-4.1-mini'],
    parsing: ['gpt-6-luna', 'gpt-4.1-mini'],
    coding: ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-5-mini'],
    mock: ['gpt-6-luna', 'gpt-4.1-mini'],
    tailor: ['gpt-6.1-terra', 'gpt-4.1'],
  },
  quality: {
    classify: ['gpt-6-luna', 'gpt-5-nano', 'gpt-4.1-mini'],
    answer: ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-4.1'],
    parsing: ['gpt-6.1-terra', 'gpt-6-luna'],
    coding: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-5'],
    mock: ['gpt-6.1-terra', 'gpt-6-luna'],
    tailor: ['gpt-6.2-sol', 'gpt-6.1-terra'],
  },
};

const ANTHROPIC: Record<ModelPreference, Plan> = {
  fast: {
    classify: ['claude-haiku-5-5', 'claude-haiku-4-5'],
    answer: ['claude-haiku-5-5', 'claude-haiku-4-5'],
    parsing: ['claude-haiku-5-5'],
    coding: ['claude-sonnet-5-5', 'claude-sonnet-5'],
    mock: ['claude-haiku-5-5'],
    tailor: ['claude-sonnet-5-5'],
  },
  balanced: {
    classify: ['claude-haiku-5-5', 'claude-haiku-4-5'],
    answer: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5'],
    parsing: ['claude-haiku-5-5'],
    coding: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    mock: ['claude-haiku-5-5'],
    tailor: ['claude-sonnet-5-5'],
  },
  quality: {
    classify: ['claude-haiku-5-5', 'claude-haiku-4-5'],
    answer: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    parsing: ['claude-sonnet-5-5'],
    coding: ['claude-fable-5-2', 'claude-opus-5-5'],
    mock: ['claude-sonnet-5-5'],
    tailor: ['claude-opus-5-5'],
  },
};

const GOOGLE: Record<ModelPreference, Plan> = {
  fast: {
    classify: ['gemini-3.5-flash-lite'],
    answer: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
    parsing: ['gemini-3.5-flash-lite'],
    coding: ['gemini-3.8-flash'],
    mock: ['gemini-3.5-flash-lite'],
    tailor: ['gemini-3.8-flash'],
  },
  balanced: {
    classify: ['gemini-3.5-flash-lite'],
    answer: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    parsing: ['gemini-3.5-flash-lite'],
    coding: ['gemini-4-carbon', 'gemini-3.8-flash'],
    mock: ['gemini-3.8-flash'],
    tailor: ['gemini-3.8-flash'],
  },
  quality: {
    classify: ['gemini-3.5-flash-lite'],
    answer: ['gemini-4-argon', 'gemini-3.8-flash'],
    parsing: ['gemini-3.8-flash'],
    coding: ['gemini-4-carbon', 'gemini-3.8-flash'],
    mock: ['gemini-3.8-flash'],
    tailor: ['gemini-4-argon', 'gemini-3.8-flash'],
  },
};

const GROQ: Record<ModelPreference, Plan> = {
  fast: {
    classify: ['openai/gpt-oss-20b'],
    answer: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
    parsing: ['openai/gpt-oss-20b'],
    coding: ['openai/gpt-oss-120b'],
    mock: ['openai/gpt-oss-20b'],
    tailor: ['openai/gpt-oss-120b'],
  },
  balanced: {
    classify: ['openai/gpt-oss-20b'],
    answer: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    parsing: ['openai/gpt-oss-20b'],
    coding: ['openai/gpt-oss-120b'],
    mock: ['openai/gpt-oss-120b'],
    tailor: ['openai/gpt-oss-120b'],
  },
  quality: {
    classify: ['openai/gpt-oss-20b'],
    answer: ['openai/gpt-oss-120b'],
    parsing: ['openai/gpt-oss-120b'],
    coding: ['openai/gpt-oss-120b'],
    mock: ['openai/gpt-oss-120b'],
    tailor: ['openai/gpt-oss-120b'],
  },
};

/** OpenRouter re-serves other vendors' models under `vendor/model` ids. Its
 *  catalog is not verified here — discovery decides what is used. */
const OPENROUTER: Record<ModelPreference, Plan> = {
  fast: {
    classify: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    answer: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    parsing: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    coding: ['anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-terra'],
    mock: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    tailor: ['anthropic/claude-sonnet-5-5'],
  },
  balanced: {
    classify: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    answer: ['anthropic/claude-sonnet-5-5', 'openai/gpt-6-luna'],
    parsing: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    coding: ['anthropic/claude-opus-5-5', 'openai/gpt-6.2-astra'],
    mock: ['anthropic/claude-haiku-5-5'],
    tailor: ['anthropic/claude-sonnet-5-5'],
  },
  quality: {
    classify: ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna'],
    answer: ['anthropic/claude-opus-5-5', 'openai/gpt-6.1-terra'],
    parsing: ['anthropic/claude-sonnet-5-5'],
    coding: ['anthropic/claude-fable-5-2', 'openai/gpt-6.2-astra'],
    mock: ['anthropic/claude-sonnet-5-5'],
    tailor: ['anthropic/claude-opus-5-5'],
  },
};

export const PROVIDER_PLANS: Record<CloudProviderId, Record<ModelPreference, Plan>> = {
  openai: OPENAI,
  anthropic: ANTHROPIC,
  google: GOOGLE,
  groq: GROQ,
  openrouter: OPENROUTER,
};

/** The pre-2.3 cost/quality preset → the preference it meant. */
export function presetToPreference(preset: string | null | undefined): ModelPreference {
  if (preset === 'low_cost' || preset === 'fast') return 'fast';
  if (preset === 'best' || preset === 'quality') return 'quality';
  return 'balanced';
}

/** The provider a user with these keys gets when they never chose one: the
 *  OpenAI key first (it also covers transcription and embeddings), then any
 *  other chat provider they configured. Null when no chat key exists. */
export function defaultChatProvider(keys: Partial<Record<CloudProviderId, boolean>>): CloudProviderId | null {
  for (const p of ['openai', 'anthropic', 'google', 'groq', 'openrouter'] as const) if (keys[p]) return p;
  return null;
}

export interface ResolveContext {
  /** The user's chosen chat provider (null = never chosen → default). */
  provider: CloudProviderId | null;
  preference: ModelPreference;
  /** The stored per-task override (qualified id), if any. */
  override?: string | null;
  keys: Partial<Record<CloudProviderId, boolean>>;
  /** Cached discovery: the ids each provider serves to this account. A
   *  provider absent here has not been discovered (no filtering). */
  discovered?: Partial<Record<CloudProviderId, readonly string[]>>;
  /** Qualified ids that failed as unavailable at runtime this process. */
  unavailable?: ReadonlySet<string>;
}

export interface TaskResolution {
  provider: CloudProviderId;
  model: string;
  source: 'override' | 'policy' | 'fallback';
  /** Why the result differs from what was asked (an override that could not
   *  run, a preferred model not served to the account). User-safe. */
  notice?: string;
}

function usable(ctx: ResolveContext, provider: CloudProviderId, model: string): string | null {
  // A missing key only disqualifies when some provider HAS one — with no key
  // at all there is nothing better to switch to, and the request's own error
  // ("needs an API key") is the useful message.
  const anyKey = Object.values(ctx.keys).some(Boolean);
  if (anyKey && !ctx.keys[provider]) return `${cloudProvider(provider)?.name ?? provider} has no API key`;
  if (ctx.unavailable?.has(qualifyModel(provider, model))) return 'it was unavailable when last tried';
  const list = ctx.discovered?.[provider];
  if (list && !list.includes(model)) return 'your account does not list it';
  return null;
}

/** Resolve one chat task to a provider + model the account can use. */
export function resolveChatTask(task: PolicyTask, ctx: ResolveContext): TaskResolution {
  let notice: string | undefined;
  if (ctx.override) {
    const { provider, model } = parseModelId(ctx.override);
    const why = usable(ctx, provider, model);
    if (!why) return { provider, model, source: 'override' };
    notice = `Your ${task} override ${modelLabel(provider, model)} can't be used (${why}) — using the ${ctx.preference} pick instead.`;
  }
  const provider = ctx.provider && ctx.keys[ctx.provider] ? ctx.provider : (defaultChatProvider(ctx.keys) ?? ctx.provider ?? 'openai');
  const candidates = PROVIDER_PLANS[provider][ctx.preference][task];
  const pick = candidates.find((m) => !usable(ctx, provider, m));
  if (pick) {
    if (pick !== candidates[0] && !notice) {
      notice = `${modelLabel(provider, candidates[0])} isn't available to your account — using ${modelLabel(provider, pick)}.`;
    }
    // 'policy' only when nothing had to give way: no rejected override and
    // the preferred candidate itself.
    const source = ctx.override || pick !== candidates[0] ? 'fallback' : 'policy';
    return { provider, model: pick, source, ...(notice ? { notice } : {}) };
  }
  // Nothing on the list is confirmed usable (no key, or discovery says none
  // is served): return the first candidate so the error names a real model.
  return {
    provider,
    model: candidates[0],
    source: 'fallback',
    notice: notice ?? `None of the ${ctx.preference} models for ${task} are confirmed available on ${cloudProvider(provider)?.name ?? provider}.`,
  };
}

function modelLabel(provider: CloudProviderId, model: string): string {
  return modelOption(provider, model)?.name ?? model;
}

const WHY: Record<ModelPreference, string> = {
  fast: 'the lowest first-token latency',
  balanced: 'fast first token with stronger answers',
  quality: 'the strongest answers that still stream live',
};

/** One line for the UI: which model answers, and why. */
export function explainAnswerModel(r: TaskResolution, preference: ModelPreference): string {
  const name = `${cloudProvider(r.provider)?.name ?? r.provider} · ${modelLabel(r.provider, r.model)}`;
  if (r.source === 'override') return `${name} — your choice in Advanced settings.`;
  return `${name} — ${preference[0].toUpperCase()}${preference.slice(1)} picks ${WHY[preference]}.${r.notice ? ` ${r.notice}` : ''}`;
}
