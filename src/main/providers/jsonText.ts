/** Appended to the system prompt for `ChatProvider.json` on vendors whose
 *  JSON mode is prompt-driven (Anthropic) or not guaranteed (some
 *  OpenAI-compatible models). */
export const STRICT_JSON_INSTRUCTION =
  'Respond with STRICT JSON only: a single JSON object, no prose before or after it, ' +
  'and no markdown code fences.';

/** Parse a model's text as JSON, tolerating a ```json fence. Throws a
 *  user-safe error on failure — callers own their fallback semantics. */
export function parseJsonText<T>(text: string, vendor: string): T {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    throw new Error(`${vendor} returned a response that isn't valid JSON.`);
  }
}
