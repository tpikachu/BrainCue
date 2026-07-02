import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';

export type PresetName = 'balanced' | 'low_cost' | 'best';

// Balanced (default): cost-effective mini/nano on the live paths; the reasoning
// coding solver where it earns its cost. Defines the task keys.
const BALANCED = {
  answer: 'gpt-4.1-mini', // the live copilot answer — good quality, ~5× cheaper than gpt-4.1
  parsing: 'gpt-4.1-mini', // one-off resume/JD parsing
  classify: 'gpt-4.1-nano', // high-frequency "is this a question?" — cheapest tier
  embedding: 'text-embedding-3-small',
  transcription: 'gpt-4o-transcribe', // accuracy here is the core input — keep it strong
  tts: 'gpt-4o-mini-tts',
  mock: 'gpt-4.1-mini', // mock interviewer questions
  // Coding-problem solver — used by BOTH the clipboard/text path (coding.ts) and the
  // screenshot path (vision.ts). The one task where a reasoning model earns its cost:
  // latency-tolerant (the user waits a beat) and correctness is the whole point.
  coding: 'gpt-5-mini',
  // Resume tailoring (Tailor Resume flow) — one-off, latency-tolerant, and the output
  // IS the user's application document, so it gets the full non-reasoning model.
  tailor: 'gpt-4.1',
} as const;

export type ModelKey = keyof typeof BALANCED;

/**
 * Cost/quality presets. The live, high-frequency paths (classify every turn, the
 * read-along answer cue) stay on FAST NON-REASONING models in EVERY preset — even
 * "best" — because a reasoning model on the hot path adds latency without helping a
 * grounded conversational cue. "Best" upgrades to the full gpt-4.1 for quality and
 * reserves a reasoning model for the latency-tolerant coding solver. Users can still
 * override any task individually (Settings → OpenAI Models) on top of the preset.
 */
export const PRESETS: Record<PresetName, Record<ModelKey, string>> = {
  balanced: BALANCED,
  low_cost: {
    answer: 'gpt-4.1-mini',
    parsing: 'gpt-4.1-nano', // cheapest tier for one-off parsing
    classify: 'gpt-4.1-nano',
    embedding: 'text-embedding-3-small',
    transcription: 'gpt-4o-mini-transcribe', // half-price STT
    tts: 'gpt-4o-mini-tts',
    mock: 'gpt-4.1-mini',
    coding: 'gpt-5-mini',
    tailor: 'gpt-4.1-mini',
  },
  best: {
    answer: 'gpt-4.1', // full model: higher quality, still non-reasoning = still snappy
    parsing: 'gpt-4.1',
    classify: 'gpt-4.1-mini',
    embedding: 'text-embedding-3-small',
    transcription: 'gpt-4o-transcribe',
    tts: 'gpt-4o-mini-tts',
    mock: 'gpt-4.1',
    coding: 'gpt-5', // strongest reasoning solver for the hardest problems
    tailor: 'gpt-5', // reasoning model may deliberate over wording; latency is fine here
  },
};

/** The Balanced table is the baseline default set (back-compat alias). */
export const defaultModels: Record<ModelKey, string> = PRESETS.balanced;

/** The active preset (defaults to balanced). */
export function modelPreset(): PresetName {
  const p = settingsRepo.get(SETTINGS_KEYS.modelPreset);
  return p === 'low_cost' || p === 'best' ? p : 'balanced';
}

/** The active preset's model table. */
export function presetModels(): Record<ModelKey, string> {
  return PRESETS[modelPreset()];
}

/** User per-task override → the active preset's model. Ids are config, not contracts. */
export function model(key: ModelKey): string {
  const overrides = settingsRepo.getJson<Record<string, string>>(SETTINGS_KEYS.models, {});
  return overrides[key] || presetModels()[key];
}

/** Reasoning effort for GPT-5 / o-series models. Higher = better quality but more
 *  hidden reasoning tokens + longer total completion (time-to-first-token stays
 *  flat). Non-reasoning models (gpt-4.1 / gpt-4o family) REJECT this param, so it's
 *  only ever sent to a reasoning model — see reasoningParam(). */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Built-in effort per task. Only the latency-tolerant coding solver reasons by
 *  default; the live answer/classify paths stay on fast non-reasoning models. */
export const defaultEfforts: Partial<Record<ModelKey, ReasoningEffort>> = {
  coding: 'low',
  tailor: 'medium', // only sent when the resolved tailor model is a reasoning one ('best')
};

/** Effective effort for a task (user override → built-in default → none). */
export function reasoningEffort(key: ModelKey): ReasoningEffort | null {
  const overrides = settingsRepo.getJson<Record<string, string>>(
    SETTINGS_KEYS.reasoningEfforts,
    {},
  );
  return (overrides[key] as ReasoningEffort) || defaultEfforts[key] || null;
}

/** GPT-5 family + o-series accept reasoning.effort; gpt-4.1 / gpt-4o reject it. */
export function isReasoningModel(id: string): boolean {
  return /^(gpt-5|o\d)/i.test(id);
}

/** Responses-API reasoning param for a task — empty unless the resolved model is a
 *  reasoning model AND an effort is configured, so we never send `reasoning` to a
 *  model that would reject it. Spread into the responses.create/stream request. */
export function reasoningParam(
  key: ModelKey,
): { reasoning: { effort: ReasoningEffort } } | Record<string, never> {
  const effort = reasoningEffort(key);
  if (effort && isReasoningModel(model(key))) return { reasoning: { effort } };
  return {};
}

export const EMBEDDING_DIM = 1536;
