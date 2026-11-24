import type { CloudProviderId } from '@shared/providers';
import type { ModelKey } from '../services/openai/models';

/**
 * The per-task route (provider + bare model id) the routed chat/vision
 * providers dispatch on. `models.ts` installs its `resolveModel` here at load
 * — that module is where presets and the user's per-task overrides live —
 * and this file deliberately imports nothing at runtime, so the registry can
 * be loaded in a plain node test without the settings DB behind it. When no
 * resolver is installed (unit tests that stub `models.ts`) every task routes
 * to OpenAI, exactly the pre-multi-provider behavior.
 */
export interface TaskRoute {
  provider: CloudProviderId;
  model: string;
}

type TaskRouteResolver = (task: ModelKey) => TaskRoute;

let resolver: TaskRouteResolver | null = null;

export function installTaskRouteResolver(fn: TaskRouteResolver): void {
  resolver = fn;
}

type UnavailableMarker = (route: TaskRoute) => void;
let markUnavailable: UnavailableMarker | null = null;

/** models.ts installs where "this model is not served" is remembered. */
export function installUnavailableMarker(fn: UnavailableMarker): void {
  markUnavailable = fn;
}

/** A request failed because its model is not served to the account:
 *  remember THAT route — the one the request was sent on, captured before it
 *  was sent. (Resolving "the task's route" when the error arrives blamed
 *  whatever the task resolves to by then: a concurrent failure marked the
 *  healthy fallback, and a key removed mid-request moved the retry to
 *  another provider.) */
export function markRouteUnavailable(route: TaskRoute): void {
  markUnavailable?.(route);
}

/** After a model error on `failed` (the attempt's captured route): mark it,
 *  then return the route to retry on — only a DIFFERENT model on the SAME
 *  provider, else null (the error surfaces; nothing moves elsewhere). */
export function retryRouteAfterModelError(task: ModelKey, failed: TaskRoute): TaskRoute | null {
  markRouteUnavailable(failed);
  const next = taskRoute(task);
  return next && next.provider === failed.provider && next.model !== failed.model ? next : null;
}

/** The full route (provider + model) for a task, or null before a resolver
 *  is installed — latency records name the model that answered. */
export function taskRoute(task: ModelKey): TaskRoute | null {
  try {
    return resolver ? resolver(task) : null;
  } catch {
    return null;
  }
}

/** The provider a task currently routes to (`openai` until a resolver exists). */
export function taskProvider(task: ModelKey): CloudProviderId {
  return resolver ? resolver(task).provider : 'openai';
}
