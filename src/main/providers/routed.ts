import { cloudProvider } from '@shared/providers';
import type { ModelKey } from '../services/openai/models';
import { CapabilityUnavailableError } from './errors';
import { taskProvider } from './taskRoute';
import type {
  Capability,
  CapabilityMap,
  ChatJsonRequest,
  ChatProvider,
  VisionProvider,
} from './types';

/**
 * Per-TASK routing for `chat` and `vision` (milestone 5.1). The registry
 * selects these as the `chat`/`vision` implementation; each call resolves the
 * task's model through `models.ts` (`anthropic/claude-opus-5` → Anthropic,
 * a bare id → OpenAI) and dispatches to that provider's registered adapter.
 * Vision has no task of its own — the screenshot solver IS the `coding`
 * task, so it follows the coding model.
 *
 * A factory (not a module-level singleton) so the registry hands in its own
 * lookup instead of the two files importing each other.
 */
type Lookup = (provider: string, capability: Capability) => unknown;

function gapHint(capability: 'chat' | 'vision', provider: string): string {
  const name = cloudProvider(provider)?.name ?? provider;
  return capability === 'vision'
    ? `${name} can't read screenshots. Pick a vision-capable model for the coding solver in Settings → Language Models.`
    : `${name} can't generate answers here. Pick another model for this task in Settings → Language Models.`;
}

export function createRouted(lookup: Lookup): {
  routedChat: ChatProvider;
  routedVision: VisionProvider;
} {
  function pick<C extends 'chat' | 'vision'>(task: ModelKey, capability: C): CapabilityMap[C] {
    const provider = taskProvider(task);
    const impl = lookup(provider, capability);
    if (!impl) {
      throw new CapabilityUnavailableError(capability, provider, gapHint(capability, provider));
    }
    return impl as CapabilityMap[C];
  }

  const routedChat: ChatProvider = {
    // Async generator (not a plain delegate) so a routing failure surfaces on
    // the first `next()` inside the caller's for-await, like a transport error.
    async *stream(req) {
      yield* pick(req.task, 'chat').stream(req);
    },
    json<T>(req: ChatJsonRequest): Promise<T> {
      return pick(req.task, 'chat').json<T>(req);
    },
    async warm(task) {
      try {
        await pick(task, 'chat').warm?.(task);
      } catch {
        /* a routing gap surfaces on the real request, with its hint */
      }
    },
  };

  const routedVision: VisionProvider = {
    async *streamSolve(input) {
      yield* pick('coding', 'vision').streamSolve(input);
    },
  };

  return { routedChat, routedVision };
}
