/**
 * What KIND of failure a provider error is — the input to bounded retry and
 * same-provider model fallback (engine/engineSession.ts, openai/questions.ts)
 * and to the user-facing message. Duck-typed over the OpenAI and Anthropic
 * SDK errors and the OpenAI-compatible adapter's re-thrown errors (whose
 * `cause` is the SDK error), so it needs no SDK imports.
 *
 *   auth     401/403 — the key is wrong or lacks access; retrying is useless
 *   quota    429 / insufficient_quota — retrying now makes it worse
 *   model    the model is not served to this account (404, model_not_found,
 *            "does not exist", decommissioned) — try the next candidate
 *   network  connection reset/timeout or a 5xx/overloaded — one retry
 *   aborted  the user cancelled (regenerate, clear, stop)
 *   other    anything else — surface it
 */
export type ProviderErrorKind = 'auth' | 'quota' | 'model' | 'network' | 'aborted' | 'other';

interface ErrLike {
  status?: number;
  code?: string;
  name?: string;
  message?: string;
  error?: { code?: string; type?: string };
  cause?: unknown;
}

export function providerErrorKind(e: unknown): ProviderErrorKind {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  let kind: ProviderErrorKind = 'other';
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const x = cur as ErrLike;
    const msg = `${x.message ?? ''}`;
    const code = `${x.code ?? x.error?.code ?? x.error?.type ?? ''}`;
    if (x.name === 'AbortError' || /aborted|APIUserAbortError/i.test(`${x.name} ${msg}`)) return 'aborted';
    if (x.status === 401 || x.status === 403 || /invalid_api_key|authentication/i.test(code)) return 'auth';
    if (x.status === 429 || /insufficient_quota|rate_limit/i.test(code)) return 'quota';
    if (
      /model_not_found|model_not_available/i.test(code) ||
      // Model ids contain dots (gpt-4.1-nano), so the gap is "same line", not "same sentence".
      /\bmodel\b[^\n]{0,80}?(not found|does not exist|not available|not supported|no longer|decommissioned|deprecated|unknown model|invalid model)/i.test(msg) ||
      (x.status === 404 && /model/i.test(msg))
    )
      return 'model';
    if (
      (x.status !== undefined && x.status >= 500) ||
      x.status === 408 ||
      x.status === 529 ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|Connection error|network|overloaded/i.test(`${code} ${msg}`)
    )
      kind = 'network';
    cur = x.cause;
  }
  return kind;
}
