import { providerFor } from '../../providers/registry';
import { providerErrorKind } from '../../providers/errorKind';
import { retryRouteAfterModelError, taskRoute, type TaskRoute } from '../../providers/taskRoute';
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

/** Each attempt's route is resolved ONCE, before it is sent, and travels
 *  with the request; a model error is attributed to that captured route,
 *  and the retry is pinned to its provider (retryRouteAfterModelError). */
function nextAfter(e: unknown, task: ModelKey, failed: TaskRoute | null): TaskRoute | null {
  if (!failed || providerErrorKind(e) !== 'model') return null;
  return retryRouteAfterModelError(task, failed);
}

/** JSON-mode call; parse errors propagate (callers own their defaults). */
export async function chatJson<T>(req: ChatTaskRequest): Promise<T> {
  const route = taskRoute(req.task);
  try {
    return await providerFor('chat').json<T>({ ...req, ...(route ? { route } : {}) });
  } catch (e) {
    const next = nextAfter(e, req.task, route);
    if (!next) throw e;
    return providerFor('chat').json<T>({ ...req, route: next });
  }
}

/** Plain-text call (collected from the stream), trimmed. */
export async function chatText(req: ChatTaskRequest): Promise<string> {
  let route = taskRoute(req.task);
  for (let attempt = 0; ; attempt++) {
    let out = '';
    try {
      for await (const ev of providerFor('chat').stream({ ...req, ...(route ? { route } : {}) }))
        if (ev.type === 'delta') out += ev.token;
      return out.trim();
    } catch (e) {
      const next = attempt >= 1 || out ? null : nextAfter(e, req.task, route);
      if (!next) throw e;
      route = next;
    }
  }
}
