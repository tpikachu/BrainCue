import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';

// Cost-effective defaults: the mini/nano tiers are plenty for grounded,
// short interview answers and keep per-session cost low. Power users can upgrade
// any task to gpt-4.1 in Settings → OpenAI Models. Transcription stays on the full
// model since accuracy there drives every downstream answer.
export const defaultModels = {
  answer: 'gpt-4.1-mini', // the live copilot answer — good quality, ~5× cheaper than gpt-4.1
  parsing: 'gpt-4.1-mini', // one-off resume/JD parsing
  classify: 'gpt-4.1-nano', // high-frequency "is this a question?" — cheapest tier
  embedding: 'text-embedding-3-small',
  transcription: 'gpt-4o-transcribe', // accuracy here is the core input — keep it strong
  tts: 'gpt-4o-mini-tts',
  mock: 'gpt-4.1-mini', // mock interviewer questions
  vision: 'gpt-4.1-mini', // coding-screenshot solve
} as const;

export type ModelKey = keyof typeof defaultModels;

/** User overrides merged over defaults. Model ids are config, not contracts. */
export function model(key: ModelKey): string {
  const overrides = settingsRepo.getJson<Record<string, string>>(SETTINGS_KEYS.models, {});
  return overrides[key] || defaultModels[key];
}

export const EMBEDDING_DIM = 1536;
