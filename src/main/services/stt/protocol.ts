/**
 * Messages between main and the sherpa-onnx utility process (worker.ts).
 * Types only — both sides import this, nothing runs here.
 *
 * `sid` is the stream id the parent hands to `load`. The worker decodes
 * SEVERAL streams at once on the one loaded recognizer — a live session opens
 * one per captured audio stream (the call's system audio and the user's
 * microphone) — so `audio` carries the sid of the stream a frame belongs to,
 * `stop` ends only that stream, and every output message echoes the sid it
 * came from, so a late final from a stream the parent already closed is
 * dropped instead of landing on another stream's callbacks.
 *
 * `sid` 0 is a warm-up: build the recognizer, open no stream.
 */

export interface LoadMessage {
  type: 'load';
  sid: number;
  modelDir: string;
  files: { encoder: string; decoder: string; joiner: string; tokens: string };
  /** Profile language (e.g. 'en') or null for automatic detection. */
  language: string | null;
  /** Only multilingual models read the per-stream language option. */
  multilingual: boolean;
}

export type WorkerIn =
  | LoadMessage
  /** PCM16 mono 24 kHz as captured by the app, for the stream `sid`. */
  | { type: 'audio'; sid: number; pcm: ArrayBuffer }
  /** End the stream `sid`; flushes its remaining text as a final. Other
   *  streams keep decoding. */
  | { type: 'stop'; sid: number };

export type WorkerOut =
  | { type: 'ready' }
  | { type: 'loaded'; sid: number }
  | { type: 'delta'; sid: number; text: string }
  | { type: 'final'; sid: number; text: string }
  | { type: 'stopped'; sid: number }
  | { type: 'error'; sid: number | null; message: string };
