import Anthropic from '@anthropic-ai/sdk';
import { modelOption } from '@shared/providers';
import { visionSolvePrompt } from '../../services/openai/codingPrompt';
import {
  reasoningEffortOverride,
  resolveModel,
  type ModelKey,
} from '../../services/openai/models';
import { STRICT_JSON_INSTRUCTION, parseJsonText } from '../jsonText';
import type { ChatJsonRequest, ChatProvider, ChatStreamEvent, VisionProvider } from '../types';
import { anthropicClient } from './client';

/**
 * Anthropic: native Messages API adapter for `chat` + `vision`. Transport
 * only — prompts, ceilings and domain events come from the calling service
 * modules, exactly as for OpenAI.
 *
 * Thinking / effort policy (Anthropic API reference, 2026-09):
 *  - `claude-fable-5-1`: thinking is always on; any explicit `thinking`
 *    config other than adaptive is a 400, so the parameter is OMITTED and
 *    depth is controlled with `output_config.effort`. Server-side fallbacks
 *    are on by default (`fallbacks: 'default'` + its beta) so a safety
 *    refusal re-runs on a fallback model inside the same call.
 *  - `claude-opus-5` / `claude-sonnet-5`: adaptive thinking is the default
 *    when `thinking` is omitted — omitted here too; `output_config.effort`
 *    sets depth.
 *  - `claude-haiku-4-5`: neither adaptive thinking nor `effort` — send neither.
 *  - Never `budget_tokens`, `temperature`, `top_p` (400 on the 5-series).
 *
 * Effort per task: live paths (`answer`, `classify`, `mock`, `parsing`) run
 * at `low` (first-token latency matters); `coding` / `tailor` follow the
 * user's reasoning-effort override when set, else `high`.
 */

/** Thinking tokens count against `max_tokens` FIRST — the same headroom the
 *  OpenAI adapter gives its reasoning models. */
const REASONING_HEADROOM = 1024;
const DEFAULT_MAX_TOKENS = 4096;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const REFUSED_MESSAGE = 'The model declined this request.';

type Effort = 'low' | 'medium' | 'high';

const LIVE_TASKS: ReadonlySet<ModelKey> = new Set<ModelKey>([
  'answer',
  'classify',
  'mock',
  'parsing',
]);

/** Catalog `reasoning: true` ⇒ adaptive thinking + `effort` supported. An id
 *  the catalog doesn't know is assumed reasoning unless it's a Haiku. */
export function isReasoningClaude(modelId: string): boolean {
  const known = modelOption('anthropic', modelId);
  return known ? known.reasoning === true : !/haiku/i.test(modelId);
}

const isFable = (modelId: string): boolean => /^claude-fable-/i.test(modelId);

/** `output_config.effort` for a task on a model — `null` means don't send it. */
export function anthropicEffort(task: ModelKey, modelId: string): Effort | null {
  if (!isReasoningClaude(modelId)) return null;
  if (LIVE_TASKS.has(task)) return 'low';
  const override = reasoningEffortOverride(task);
  if (override === 'minimal' || override === 'low') return 'low';
  if (override === 'medium') return 'medium';
  return 'high';
}

function buildParams(
  task: ModelKey,
  modelId: string,
  system: string,
  content: string | Anthropic.ContentBlockParam[],
  maxOutputTokens: number | undefined,
): Anthropic.MessageCreateParamsNonStreaming {
  const effort = anthropicEffort(task, modelId);
  return {
    model: modelId,
    max_tokens:
      (maxOutputTokens ?? DEFAULT_MAX_TOKENS) +
      (isReasoningClaude(modelId) ? REASONING_HEADROOM : 0),
    system,
    messages: [{ role: 'user', content }],
    ...(effort ? { output_config: { effort } } : {}),
  };
}

/** Fable opts into server-side fallbacks, which live on the beta surface. */
function withFallbacks(params: Anthropic.MessageCreateParamsNonStreaming) {
  return { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' as const };
}

async function* run(
  task: ModelKey,
  system: string,
  content: string | Anthropic.ContentBlockParam[],
  maxOutputTokens: number | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatStreamEvent> {
  const client = await anthropicClient();
  const { model: modelId } = resolveModel(task);
  const params = buildParams(task, modelId, system, content, maxOutputTokens);
  const stream = isFable(modelId)
    ? client.beta.messages.stream(withFallbacks(params), { signal })
    : client.messages.stream(params, { signal });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'delta', token: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new Error(REFUSED_MESSAGE);
  yield {
    type: 'usage',
    prompt: final.usage.input_tokens,
    completion: final.usage.output_tokens,
  };
}

export const anthropicChat: ChatProvider = {
  stream(req) {
    return run(req.task, req.system, req.user, req.maxOutputTokens, req.signal);
  },

  async json<T>(req: ChatJsonRequest): Promise<T> {
    const client = await anthropicClient();
    const { model: modelId } = resolveModel(req.task);
    const params = buildParams(
      req.task,
      modelId,
      `${req.system}\n\n${STRICT_JSON_INSTRUCTION}`,
      req.user,
      req.maxOutputTokens,
    );
    const res = isFable(modelId)
      ? await client.beta.messages.create(withFallbacks(params))
      : await client.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error(REFUSED_MESSAGE);
    const text = res.content.find((b) => b.type === 'text');
    return parseJsonText<T>(text && 'text' in text ? text.text : '', 'Anthropic');
  },
};

/** `data:image/png;base64,…` → an Anthropic image block. */
export function imageBlockFromDataUrl(dataUrl: string): Anthropic.ImageBlockParam {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/s.exec(dataUrl);
  if (!m) {
    throw new Error('Unsupported screenshot format — expected a PNG, JPEG, GIF or WebP image.');
  }
  const media_type = (m[1] === 'jpg' ? 'image/jpeg' : `image/${m[1]}`) as
    Anthropic.Base64ImageSource['media_type'];
  return { type: 'image', source: { type: 'base64', media_type, data: m[2] } };
}

export const anthropicVision: VisionProvider = {
  async *streamSolve(input) {
    const { system, intro } = visionSolvePrompt(
      input.imageDataUrls.length,
      input.language,
      input.format,
    );
    const content: Anthropic.ContentBlockParam[] = [
      ...input.imageDataUrls.map(imageBlockFromDataUrl),
      { type: 'text', text: intro },
    ];
    yield* run('coding', system, content, undefined, input.signal);
    yield { type: 'meta', riskWarning: null };
  },
};
