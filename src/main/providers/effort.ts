import { LIVE_TASKS } from '@shared/modelPolicy';
import { modelOption, type CloudProviderId } from '@shared/providers';
import { isReasoningModel, reasoningEffort, type ModelKey, type ReasoningEffort } from '../services/openai/models';

/**
 * The reasoning effort to send for a task on a model — from the catalog's
 * explicit capability metadata (`efforts`, lowest first), not the model's
 * name. Null = send none (a non-reasoning model rejects the parameter).
 *
 * Live tasks (classify, answer, mock) and parsing take the model's LOWEST
 * accepted effort ("none" on GPT-6 Luna/Terra, "minimal" on Gemini, "low"
 * on GPT-OSS) whatever the overrides say: first-token latency is the
 * product. Other tasks honour the user's override when the model accepts
 * it, else the built-in default, clamped to what the model accepts.
 */
export function effortFor(key: ModelKey, provider: CloudProviderId, modelId: string): ReasoningEffort | null {
  const opt = modelOption(provider, modelId);
  const reasoning = opt ? opt.reasoning === true : provider === 'openai' && isReasoningModel(modelId);
  if (!reasoning) return null;
  const accepted = (opt?.efforts ?? ['low', 'medium', 'high']) as readonly ReasoningEffort[];
  if (LIVE_TASKS.has(key) || key === 'parsing') return accepted[0];
  const wanted = reasoningEffort(key) ?? 'low';
  if (accepted.includes(wanted)) return wanted;
  const order: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return accepted.find((e) => order.indexOf(e) >= order.indexOf(wanted)) ?? accepted[accepted.length - 1];
}

/** The installed SDK (openai 4.104) types `reasoning.effort` as only
 *  low/medium/high; the API accepts the full set (verified live with "none"
 *  on 2026-11-17) and the SDK forwards the body unchanged. This is the ONE
 *  place that bridges the type — upgrading the SDK is out of scope here. */
export type SdkReasoning = { reasoning?: { effort: 'low' | 'medium' | 'high' } };
export function reasoningBody(effort: ReasoningEffort | null): SdkReasoning {
  return effort ? ({ reasoning: { effort } } as unknown as SdkReasoning) : {};
}
