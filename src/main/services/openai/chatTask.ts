import { providerFor } from '../../providers/registry';
import { providerErrorKind } from '../../providers/errorKind';
import { reportUnavailable, taskRoute } from '../../providers/taskRoute';
import type { ModelKey } from './models';

/**
 * One-shot chat calls for the latency-tolerant features — résumé/JD/company
 * parsing, prep briefs, story drafts, the coaching report, mock-interview
 * questions and sparring feedback.
 *
 * They go through the ROUTED chat provider, so each runs on the provider its
 * task resolves to (the user's chosen provider + preference, or an explicit
 * override). Calling the OpenAI SDK directly with `model(task)` stopped being
 * safe once a task could resolve to another provider: an Anthropic user's
 * report sent a Claude model id to OpenAI — or failed on the missing OpenAI
 * key. Features that genuinely only exist on OpenAI use `openaiOnlyModel`
 * (models.ts) instead, behind their own readiness gate.
 *
 * Bounded failover, the same rule as the live answer path: a model the
 * account does not have is marked unavailable and the call is retried ONCE
 * on the next candidate of the SAME provider. Never another provider, never
 * after the first streamed token (a partial reply is not replayed). Every
 * other error surfaces unchanged.
 */
export interface ChatTaskRequest {
  task: ModelKey;
  system: string;
  user: string;
  /** Output ceiling. Anthropic requires one (its default is 4096), so the
   *  long structured outputs pass a larger one explicitly. */
  maxOutputTokens?: number;
}

/** After a model error: may this task retry? Only when the next route is a
 *  DIFFERENT model on the SAME provider as the one that failed. */
function retryableAfterModelError(e: unknown, task: ModelKey): boolean {
  if (providerErrorKind(e) !== 'model') return false;
  const failed = reportUnavailable(task);
  const next = taskRoute(task);
  return !!failed && !!next && next.provider === failed.provider && next.model !== failed.model;
}

/** JSON-mode call; parse errors propagate (callers own their defaults). */
export async function chatJson<T>(req: ChatTaskRequest): Promise<T> {
  try {
    return await providerFor('chat').json<T>(req);
  } catch (e) {
    if (!retryableAfterModelError(e, req.task)) throw e;
    return providerFor('chat').json<T>(req);
  }
}

/** Plain-text call (collected from the stream), trimmed. */
export async function chatText(req: ChatTaskRequest): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let out = '';
    try {
      for await (const ev of providerFor('chat').stream(req)) if (ev.type === 'delta') out += ev.token;
      return out.trim();
    } catch (e) {
      if (attempt >= 1 || out || !retryableAfterModelError(e, req.task)) throw e;
    }
  }
}
