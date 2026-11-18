import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { CLOUD_PROVIDERS, modelOption, parseModelId, qualifyModel, type CloudProviderId } from '@shared/providers';
import {
  PROVIDER_PLANS,
  presetToPreference,
  resolveChatTask,
  type ModelPreference,
  type PolicyTask,
  type TaskResolution,
} from '@shared/modelPolicy';
import { installTaskRouteResolver, installUnavailableMarker } from '../../providers/taskRoute';
import { effortFor, reasoningBody, type SdkReasoning } from '../../providers/effort';

/**
 * Per-task model resolution (docs/06-OPENAI-SERVICE.md §Model selection).
 *
 * Chat tasks resolve through the provider-aware policy (shared/
 * modelPolicy.ts): the user's chosen provider + Fast/Balanced/Quality
 * preference pick a model per task, filtered by the cached discovery list
 * and by models that failed as unavailable this process; a per-task
 * override from Advanced settings wins when it can actually run.
 *
 * Non-chat tasks (embeddings, transcription, speech) stay on OpenAI — the
 * only provider wired for them.
 */

/** Legacy preset names — still accepted from stored settings and older
 *  renderers; they map onto the three preferences. */
export type PresetName = 'balanced' | 'low_cost' | 'best';

const NON_CHAT = {
  // Embedding SPACE identity — changing it requires a re-index
  // (rag/embeddingIdentity.ts), so it is pinned, not policy-picked.
  embedding: 'text-embedding-3-small',
  // gpt-4o-transcribe is still served (deprecated, shutdown 2027-02-26); its
  // successors' Realtime WebSocket support is not yet verified here.
  transcription: 'gpt-4o-transcribe',
  tts: 'gpt-4o-mini-tts',
} as const;

const CHAT_TASKS = ['answer', 'parsing', 'classify', 'mock', 'coding', 'tailor'] as const;
export type ModelKey = (typeof CHAT_TASKS)[number] | keyof typeof NON_CHAT;

const isChatTask = (k: ModelKey): k is PolicyTask => (CHAT_TASKS as readonly string[]).includes(k);

/** The preferred OpenAI model per task for each legacy preset — the policy's
 *  first candidate. Kept for the settings UI's "effective defaults" and for
 *  callers that still think in presets. */
export const PRESETS: Record<PresetName, Record<ModelKey, string>> = {
  balanced: { ...firstCandidates('balanced'), ...NON_CHAT },
  low_cost: { ...firstCandidates('fast'), ...NON_CHAT, transcription: 'gpt-4o-mini-transcribe' },
  best: { ...firstCandidates('quality'), ...NON_CHAT },
};

function firstCandidates(p: ModelPreference): Record<PolicyTask, string> {
  const plan = PROVIDER_PLANS.openai[p];
  return Object.fromEntries(CHAT_TASKS.map((t) => [t, plan[t][0]])) as Record<PolicyTask, string>;
}

/** The Balanced table is the baseline default set (back-compat alias). */
export const defaultModels: Record<ModelKey, string> = PRESETS.balanced;

/** The active legacy preset (defaults to balanced). */
export function modelPreset(): PresetName {
  const p = settingsRepo.get(SETTINGS_KEYS.modelPreset);
  if (p === 'low_cost' || p === 'fast') return 'low_cost';
  if (p === 'best' || p === 'quality') return 'best';
  return 'balanced';
}

/** The user's Fast / Balanced / Quality preference. */
export function modelPreference(): ModelPreference {
  return presetToPreference(settingsRepo.get(SETTINGS_KEYS.modelPreset));
}

/** The user's chosen chat provider, or null when they never chose one. */
export function chatProviderSetting(): CloudProviderId | null {
  const v = settingsRepo.get(SETTINGS_KEYS.chatProvider);
  return CLOUD_PROVIDERS.some((p) => p.id === v) ? (v as CloudProviderId) : null;
}

/** The active preset's OpenAI table (legacy view). */
export function presetModels(): Record<ModelKey, string> {
  return PRESETS[modelPreset()];
}

// ---- key presence, discovery, runtime availability ----

type KeyPresence = () => Partial<Record<CloudProviderId, boolean>>;
/** Main installs the real check (env key + encrypted store); the default
 *  reads the presence flags directly so this module loads without Electron. */
let keyPresence: KeyPresence = () => {
  // Defensive: a missing flag (or a settings stub without the key helpers)
  // simply reads as "no key".
  const flag = (k: string | undefined) => {
    try {
      return !!k && settingsRepo.get(k) === '1';
    } catch {
      return false;
    }
  };
  const out: Partial<Record<CloudProviderId, boolean>> = {
    openai: !!process.env.OPENAI_API_KEY || flag(SETTINGS_KEYS.apiKeyPresent),
  };
  for (const p of CLOUD_PROVIDERS) {
    if (p.id !== 'openai') out[p.id] = flag(SETTINGS_KEYS.providerKeyPresent?.(p.id));
  }
  return out;
};
export function installKeyPresence(fn: KeyPresence): void {
  keyPresence = fn;
}

/** Discovery older than this no longer filters (a stale list must not hide
 *  a model the vendor added since). */
export const DISCOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiscoveryEntry {
  ids: string[];
  at: number;
}

function discovered(): Partial<Record<CloudProviderId, string[]>> {
  const raw = settingsRepo.getJson<Record<string, DiscoveryEntry>>(SETTINGS_KEYS.modelDiscovery, {});
  const out: Partial<Record<CloudProviderId, string[]>> = {};
  const now = Date.now();
  for (const [p, e] of Object.entries(raw ?? {})) {
    if (e && Array.isArray(e.ids) && e.ids.length && now - e.at <= DISCOVERY_MAX_AGE_MS) out[p as CloudProviderId] = e.ids;
  }
  return out;
}

/** Qualified ids that failed as "model not found/unavailable" this process. */
const unavailable = new Set<string>();

/** A request failed because the model is not served to this account — skip
 *  it from now on (this process) so the next request resolves to the next
 *  candidate on the same provider. Never switches provider. */
export function markModelUnavailable(provider: CloudProviderId, model: string): void {
  unavailable.add(qualifyModel(provider, model));
}

installUnavailableMarker((r) => markModelUnavailable(r.provider, r.model));

/** Test seam. */
export function resetRuntimeAvailability(): void {
  unavailable.clear();
}

// ---- resolution ----

function overrides(): Record<string, string> {
  return settingsRepo.getJson<Record<string, string>>(SETTINGS_KEYS.models, {}) ?? {};
}

/** The full resolution for a chat task — model, source, and any notice. */
export function resolveTask(key: PolicyTask): TaskResolution {
  return resolveChatTask(key, {
    provider: chatProviderSetting(),
    preference: modelPreference(),
    override: overrides()[key] || null,
    keys: keyPresence(),
    discovered: discovered(),
    unavailable,
  });
}

/**
 * Per-task provider + bare model id. Chat tasks go through the policy; a
 * bare stored override is OpenAI (every setting written before
 * multi-provider still resolves the same way) and a known provider prefix
 * routes elsewhere. The routed chat/vision providers dispatch on this.
 */
export function resolveModel(key: ModelKey): { provider: CloudProviderId; model: string } {
  if (isChatTask(key)) {
    const r = resolveTask(key);
    return { provider: r.provider, model: r.model };
  }
  const o = overrides()[key];
  return o ? parseModelId(o) : { provider: 'openai', model: NON_CHAT[key] };
}

/** The BARE vendor id for a task (never `provider/…`), so OpenAI callers are
 *  unchanged. Ids are config, not contracts. */
export function model(key: ModelKey): string {
  return resolveModel(key).model;
}

// Routing dispatches on this module's resolution but must not import it
// (see providers/taskRoute.ts) — install it once, at load.
installTaskRouteResolver(resolveModel);

// ---- reasoning effort ----

/** Reasoning effort values the app may request. Each model accepts a subset
 *  (catalog `efforts`); `none` disables hidden reasoning where it exists. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Built-in effort for the latency-tolerant tasks. The live tasks always use
 *  the model's LOWEST accepted effort (see effortFor). */
export const defaultEfforts: Partial<Record<ModelKey, ReasoningEffort>> = {
  coding: 'low',
  tailor: 'medium',
};

/** Effective effort for a task (user override → built-in default → none). */
export function reasoningEffort(key: ModelKey): ReasoningEffort | null {
  return (reasoningEffortOverride(key) as ReasoningEffort | null) || defaultEfforts[key] || null;
}

/** ONLY the user's stored effort for a task (no built-in default), as stored. */
export function reasoningEffortOverride(key: ModelKey): string | null {
  const o = settingsRepo.getJson<Record<string, string>>(SETTINGS_KEYS.reasoningEfforts, {});
  return o?.[key] || null;
}

/** Is this OpenAI model a reasoning model? Catalog metadata first; the name
 *  rule only covers ids the catalog does not know (free-typed overrides).
 *  Chat-tuned variants (`gpt-5-chat-latest`) are non-reasoning. */
export function isReasoningModel(id: string): boolean {
  const known = modelOption('openai', id);
  if (known) return known.reasoning === true;
  return /^(gpt-5|gpt-6|o\d)/i.test(id) && !/chat/i.test(id);
}

/** Responses-API reasoning param for a task — empty unless the resolved
 *  model is a reasoning model, so it is never sent to a model that rejects
 *  it. Spread into responses.create/stream. */
export function reasoningParam(key: ModelKey): SdkReasoning {
  // Resolved lazily (providers/effort.ts imports this module back).
  const { provider, model: m } = resolveModel(key);
  return reasoningBody(effortFor(key, provider, m));
}

// ---- OpenAI-only features ----

/** Is an OpenAI key configured? The readiness gate for features that only
 *  have an OpenAI implementation. */
export function hasOpenAIKey(): boolean {
  return !!keyPresence().openai;
}

/**
 * The OpenAI model for a task, for a feature that ONLY has an OpenAI
 * implementation (application tailoring: its long-generation timeout and
 * no-retry policy are OpenAI SDK options). Resolved under the user's
 * preference as if OpenAI were their provider — never another provider's
 * id, which `model(task)` returns once the user picks Anthropic. A per-task
 * override counts only when it names an OpenAI model.
 */
export function openaiOnlyModel(key: PolicyTask): string {
  const o = overrides()[key];
  return resolveChatTask(key, {
    provider: 'openai',
    preference: modelPreference(),
    override: o && parseModelId(o).provider === 'openai' ? o : null,
    keys: { openai: true },
    discovered: discovered(),
    unavailable,
  }).model;
}

/** Reasoning param for `openaiOnlyModel(key)`. */
export function openaiOnlyReasoning(key: PolicyTask): SdkReasoning {
  return reasoningBody(effortFor(key, 'openai', openaiOnlyModel(key)));
}

export const EMBEDDING_DIM = 1536;
