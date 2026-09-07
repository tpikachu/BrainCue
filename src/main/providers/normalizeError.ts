import Anthropic from '@anthropic-ai/sdk';
import { normalizeOpenAIError } from '../services/openai/client';

/**
 * Provider-agnostic error → short, user-safe message (never the key). The
 * engine's session-error path calls this for whatever provider a task routed
 * to. Anthropic SDK errors are recognised here; OpenAI-compatible adapters
 * already re-throw vendor-named plain Errors; everything else falls through
 * to the OpenAI normalizer, whose `Error → message` fallback covers them.
 */
export function normalizeProviderError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key (401). Check your key in Settings → Language Models.';
  }
  if (e instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate limit / quota reached (429). Try again shortly.';
  }
  if (e instanceof Anthropic.APIError) {
    return `Anthropic error ${e.status ?? ''}: ${e.message}`;
  }
  return normalizeOpenAIError(e);
}
