import type { AnswerFormat } from '@shared/types';
import type { ModelKey } from '../services/openai/models';

/**
 * Provider capability interfaces (PRD §6.7). The engine and service modules
 * depend on THESE, never on a vendor SDK: each concrete provider implements
 * the capabilities it has, and the registry resolves the selected provider
 * per capability. Interfaces carry TRANSPORT concerns only — prompt building,
 * format ceilings, domain events, and JSON field handling stay in the calling
 * service modules, so a second provider is a transport swap, not a rewrite.
 */

export type ProviderId = 'openai';

export type Capability = 'chat' | 'embedding' | 'realtimeStt' | 'batchStt' | 'speech' | 'vision';

/** Streaming transport events. `meta` is a DOMAIN event (answer.ts emits it
 *  after the stream) — deliberately not part of the transport contract. */
export type ChatStreamEvent =
  | { type: 'delta'; token: string }
  | { type: 'usage'; prompt: number; completion: number };

export interface ChatStreamRequest {
  /** Task key — the provider resolves the model through the app's preset +
   *  per-task override tables (models.ts), so Settings keep working. */
  task: ModelKey;
  system: string;
  user: string;
  /** Domain output ceiling. Provider-specific overheads (e.g. reasoning-token
   *  headroom on OpenAI reasoning models) are added by the provider. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ChatJsonRequest {
  task: ModelKey;
  system: string;
  user: string;
  maxOutputTokens?: number;
}

export interface ChatProvider {
  stream(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent>;
  /** One-shot JSON-mode call (classify-tier tasks). Parse errors propagate —
   *  callers own their fallback semantics. */
  json<T>(req: ChatJsonRequest): Promise<T>;
}

/** Identifies an embedding SPACE. Vectors from different identities are not
 *  comparable — switching provider/model requires a re-index (the write path
 *  refuses to mix identities; see rag/embeddingIdentity.ts). */
export interface EmbeddingIdentity {
  provider: ProviderId | string;
  model: string;
  dim: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>;
  embedOne(text: string): Promise<Float32Array>;
  identity(): EmbeddingIdentity;
}

export interface RealtimeSttCallbacks {
  onDelta: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: 'reconnecting' | 'connected' | 'disconnected') => void;
}

export interface RealtimeSttSession {
  appendAudio(base64Pcm: string): void;
  stop(): void;
}

export interface RealtimeSttProvider {
  /** Open a live STT session (already started). Expects PCM16 24 kHz mono. */
  open(cb: RealtimeSttCallbacks, opts: { language: string }): RealtimeSttSession;
}

export interface BatchSttProvider {
  transcribe(audio: ArrayBuffer, mime: string): Promise<string>;
}

export interface SpeechProvider {
  speak(text: string, voice: string): Promise<Buffer>;
}

export interface VisionProvider {
  /** Stream a grounded solve over screenshots (the capture/coding path). */
  streamSolve(input: {
    imageDataUrls: string[];
    language: string;
    format: AnswerFormat;
    signal?: AbortSignal;
  }): AsyncGenerator<ChatStreamEvent | { type: 'meta'; riskWarning: string | null }>;
}

export interface CapabilityMap {
  chat: ChatProvider;
  embedding: EmbeddingProvider;
  realtimeStt: RealtimeSttProvider;
  batchStt: BatchSttProvider;
  speech: SpeechProvider;
  vision: VisionProvider;
}
