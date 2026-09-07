import OpenAI from 'openai';
import { modelOption, type CloudProviderInfo } from '@shared/providers';
import { visionSolvePrompt } from '../../services/openai/codingPrompt';
import { resolveModel, type ModelKey } from '../../services/openai/models';
import { STRICT_JSON_INSTRUCTION, parseJsonText } from '../jsonText';
import type { ChatJsonRequest, ChatProvider, ChatStreamEvent, VisionProvider } from '../types';
import { compatClient } from './client';

/**
 * One adapter for every vendor that publishes the OpenAI **Chat Completions**
 * surface (Google Gemini, Groq, OpenRouter): the `openai` SDK with the
 * vendor's `baseURL` and key. These vendors do not implement the Responses
 * API, so this is deliberately a different code path from `providers/openai`.
 * `vision` is produced only when the catalog says the vendor accepts images.
 */

/** Same headroom rule as the other adapters: catalog `reasoning: true`
 *  models spend hidden tokens against `max_tokens` first. */
const REASONING_HEADROOM = 1024;

/** Vendor-named, user-safe message (never the key). */
export function normalizeCompatError(info: CloudProviderInfo, e: unknown): string {
  if (e instanceof OpenAI.APIError) {
    if (e.status === 401) {
      return `${info.name} rejected the API key (401). Check your key in Settings → Language Models.`;
    }
    if (e.status === 429) return `${info.name} rate limit / quota reached (429). Try again shortly.`;
    return `${info.name} error ${e.status ?? ''}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return `Unknown error calling ${info.name}.`;
}

/** SDK errors say "OpenAI" — re-throw as a plain Error that names the vendor
 *  so the session-error banner reads right. Non-SDK errors pass through. */
function vendorError(info: CloudProviderInfo, e: unknown): unknown {
  if (!(e instanceof OpenAI.APIError)) return e;
  const err = new Error(normalizeCompatError(info, e));
  (err as { cause?: unknown }).cause = e;
  return err;
}

export function openaiCompatibleProvider(info: CloudProviderInfo): {
  chat: ChatProvider;
  vision: VisionProvider | null;
} {
  const maxTokens = (modelId: string, ceiling: number | undefined) =>
    ceiling === undefined
      ? {}
      : {
          max_tokens:
            ceiling + (modelOption(info.id, modelId)?.reasoning ? REASONING_HEADROOM : 0),
        };

  async function* run(
    task: ModelKey,
    messages: OpenAI.ChatCompletionMessageParam[],
    ceiling: number | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    const client = await compatClient(info);
    const { model } = resolveModel(task);
    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...maxTokens(model, ceiling),
        },
        { signal },
      );
      let usage: OpenAI.CompletionUsage | null = null;
      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) yield { type: 'delta', token };
        if (chunk.usage) usage = chunk.usage; // only the final chunk carries it
      }
      if (usage) {
        yield {
          type: 'usage',
          prompt: usage.prompt_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
        };
      }
    } catch (e) {
      throw vendorError(info, e);
    }
  }

  const chat: ChatProvider = {
    stream(req) {
      return run(
        req.task,
        [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        req.maxOutputTokens,
        req.signal,
      );
    },

    async json<T>(req: ChatJsonRequest): Promise<T> {
      const client = await compatClient(info);
      const { model } = resolveModel(req.task);
      const base: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: [
          { role: 'system', content: `${req.system}\n\n${STRICT_JSON_INSTRUCTION}` },
          { role: 'user', content: req.user },
        ],
        ...maxTokens(model, req.maxOutputTokens),
      };
      let text: string;
      try {
        const res = await client.chat.completions.create({
          ...base,
          response_format: { type: 'json_object' },
        });
        text = res.choices[0]?.message?.content ?? '';
      } catch (e) {
        // A model/vendor that rejects `response_format` says so with a 400 —
        // the prompt already demands strict JSON, so retry without it.
        if (!(e instanceof OpenAI.APIError && e.status === 400)) throw vendorError(info, e);
        try {
          const res = await client.chat.completions.create(base);
          text = res.choices[0]?.message?.content ?? '';
        } catch (e2) {
          throw vendorError(info, e2);
        }
      }
      return parseJsonText<T>(text, info.name);
    },
  };

  const vision: VisionProvider | null = info.capabilities.includes('vision')
    ? {
        async *streamSolve(input) {
          const { system, intro } = visionSolvePrompt(
            input.imageDataUrls.length,
            input.language,
            input.format,
          );
          const content: OpenAI.ChatCompletionContentPart[] = [
            { type: 'text', text: intro },
            // Data URLs pass straight through as image_url parts.
            ...input.imageDataUrls.map((url) => ({
              type: 'image_url' as const,
              image_url: { url },
            })),
          ];
          yield* run(
            'coding',
            [
              { role: 'system', content: system },
              { role: 'user', content },
            ],
            undefined,
            input.signal,
          );
          yield { type: 'meta', riskWarning: null };
        },
      }
    : null;

  return { chat, vision };
}
