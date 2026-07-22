import { openai } from '../../services/openai/client';
import {
  EMBEDDING_DIM,
  isReasoningModel,
  model,
  reasoningEffort,
} from '../../services/openai/models';
import { embed, embedOne } from '../../services/openai/embeddings';
import { transcribeChunk } from '../../services/openai/transcription';
import { speak, type TtsVoice } from '../../services/openai/tts';
import { solveFromImages } from '../../services/openai/vision';
import { RealtimeTranscriber } from '../../services/openai/realtime';
import type {
  BatchSttProvider,
  ChatJsonRequest,
  ChatProvider,
  ChatStreamEvent,
  EmbeddingProvider,
  RealtimeSttProvider,
  SpeechProvider,
  VisionProvider,
} from '../types';

/**
 * OpenAI: the reference provider. These adapters WRAP the existing service
 * modules/SDK usage — behavior (bodies sent, retries, error normalization,
 * key flow through client.ts) is unchanged, which the existing service tests
 * pin. OpenAI-specific transport quirks live HERE: reasoning models get the
 * effort param and reasoning-token headroom on top of the caller's ceiling.
 */

/** Reasoning models burn hidden reasoning tokens against max_output_tokens
 *  FIRST — without headroom the caller's tight ceiling would be consumed
 *  before any visible text is emitted. The prompt still binds length. */
const REASONING_HEADROOM = 1024;

export const openaiChat: ChatProvider = {
  async *stream(req): AsyncGenerator<ChatStreamEvent> {
    const m = model(req.task);
    const reasoning = isReasoningModel(m);
    const stream = await openai().responses.stream(
      {
        model: m,
        ...(reasoning ? { reasoning: { effort: reasoningEffort(req.task) ?? 'low' } } : {}),
        ...(req.maxOutputTokens !== undefined
          ? { max_output_tokens: req.maxOutputTokens + (reasoning ? REASONING_HEADROOM : 0) }
          : {}),
        input: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      { signal: req.signal },
    );
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'delta', token: event.delta };
      }
    }
    const final = await stream.finalResponse();
    const usage = final.usage;
    if (usage) {
      yield {
        type: 'usage',
        prompt: usage.input_tokens ?? 0,
        completion: usage.output_tokens ?? 0,
      };
    }
  },

  async json<T>(req: ChatJsonRequest): Promise<T> {
    const res = await openai().responses.create({
      model: model(req.task),
      input: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      text: { format: { type: 'json_object' } },
      ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
    });
    return JSON.parse(res.output_text) as T;
  },
};

export const openaiEmbedding: EmbeddingProvider = {
  embed: (texts) => embed(texts),
  embedOne: (text) => embedOne(text),
  identity: () => ({ provider: 'openai', model: model('embedding'), dim: EMBEDDING_DIM }),
};

export const openaiRealtimeStt: RealtimeSttProvider = {
  open(cb, opts) {
    const transcriber = new RealtimeTranscriber(
      {
        onDelta: cb.onDelta,
        onFinal: cb.onFinal,
        onError: cb.onError,
        onStatus: cb.onStatus,
      },
      opts.language,
    );
    transcriber.start();
    return transcriber;
  },
};

export const openaiBatchStt: BatchSttProvider = {
  transcribe: (audio, mime) => transcribeChunk(audio, mime),
};

export const openaiSpeech: SpeechProvider = {
  speak: (text, voice) => speak(text, voice as TtsVoice),
};

export const openaiVision: VisionProvider = {
  streamSolve: (input) =>
    solveFromImages(input.imageDataUrls, input.language, input.format, input.signal),
};
