/** Explicitly supported current catalog ids, verified against OpenAI's Fast
 * pricing table on 2026-11-19. Do not guess support from a model-name prefix.
 * https://developers.openai.com/api/docs/pricing.md */
export const OPENAI_FAST_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'] as const;

export const supportsOpenAiFast = (model: string): boolean =>
  (OPENAI_FAST_MODELS as readonly string[]).includes(model);
