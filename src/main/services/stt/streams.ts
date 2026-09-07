/**
 * The worker's stream table — the pure part of worker.ts, kept free of the
 * native addon and the process port so it can be unit-tested with a fake
 * recognizer (streams.test.ts).
 *
 * One loaded recognizer decodes SEVERAL online streams at once: a live session
 * opens one per captured audio stream (the call's system audio and the user's
 * microphone), and each keeps its own decoder state, its own resampler state
 * and its own "last published text" so deltas and finals from the two never
 * bleed into each other. Streams are keyed by the `sid` the parent assigns.
 */
import { MODEL_SAMPLE_RATE, APP_SAMPLE_RATE, pcm16ToFloat32, resampleLinear } from './pcm';
import type { WorkerOut } from './protocol';

// ---- the slice of sherpa-onnx-node we use ---------------------------------

export interface OnlineStream {
  acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
  setOption(key: string, value: string): void;
}

export interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(s: OnlineStream): boolean;
  decode(s: OnlineStream): void;
  isEndpoint(s: OnlineStream): boolean;
  reset(s: OnlineStream): void;
  getResult(s: OnlineStream): { text: string };
}

/** sherpa's stateful resampler (keeps the fractional phase between frames).
 *  Null → the pure per-frame fallback in pcm.ts. */
export interface Resampler {
  resample(samples: Float32Array): Float32Array;
  reset(): void;
}

interface StreamState {
  stream: OnlineStream;
  lastText: string;
  resampler: Resampler | null;
}

export class StreamTable {
  private readonly streams = new Map<number, StreamState>();

  constructor(private readonly post: (m: WorkerOut) => void) {}

  get size(): number {
    return this.streams.size;
  }

  has(sid: number): boolean {
    return this.streams.has(sid);
  }

  sids(): number[] {
    return [...this.streams.keys()];
  }

  /** Register a freshly created stream under `sid`. A sid that is already
   *  open is replaced silently — after a worker restart the parent re-sends
   *  `load` for every open session, and the new process has no old stream. */
  open(sid: number, stream: OnlineStream, resampler: Resampler | null): void {
    this.streams.set(sid, { stream, lastText: '', resampler });
  }

  /** Feed one PCM16 24 kHz frame to the stream `sid`, decode what is ready,
   *  and publish a delta / final for THAT stream. Frames for an unknown sid
   *  (a stream already stopped) are dropped. Returns whether it was fed. */
  audio(recognizer: OnlineRecognizer, sid: number, pcm: ArrayBuffer): boolean {
    const st = this.streams.get(sid);
    if (!st) return false;
    const f32 = pcm16ToFloat32(pcm);
    const samples = st.resampler
      ? st.resampler.resample(f32)
      : resampleLinear(f32, APP_SAMPLE_RATE, MODEL_SAMPLE_RATE);
    if (samples.length === 0) return true;
    st.stream.acceptWaveform({ sampleRate: MODEL_SAMPLE_RATE, samples });
    this.decodePending(recognizer, st.stream);
    this.publish(recognizer, sid, st);
    return true;
  }

  /** End the stream `sid`: decode what is left, flush it as a final, and
   *  forget the stream. Always answers `stopped` so the parent can settle,
   *  even for a sid it never opened. Other streams are untouched. */
  stop(recognizer: OnlineRecognizer | null, sid: number): void {
    const st = this.streams.get(sid);
    if (!st || !recognizer) {
      this.post({ type: 'stopped', sid });
      return;
    }
    try {
      st.stream.inputFinished();
      this.decodePending(recognizer, st.stream);
      const text = recognizer.getResult(st.stream).text?.trim() ?? '';
      if (text) this.post({ type: 'final', sid, text });
    } finally {
      this.streams.delete(sid);
      st.resampler?.reset();
      this.post({ type: 'stopped', sid });
    }
  }

  /** Drop every stream without flushing (the recognizer they belong to is
   *  being replaced). */
  clear(): void {
    this.streams.clear();
  }

  private decodePending(recognizer: OnlineRecognizer, stream: OnlineStream): void {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }

  /** Emit a delta when the text moved; on an endpoint emit the final and reset.
   *
   *  A delta carries only what was ADDED since the last one — the same
   *  contract as the cloud transcriber, whose consumers (dashboard store, Cue
   *  Card) append deltas into one in-flight line. Publishing the whole result
   *  each time made that line read "MorningMorning. Have you hadMorning…".
   *  Greedy transducer decoding never retracts a token, so the new result
   *  always extends the last one; if it ever did not, the full text is sent
   *  rather than nothing. */
  private publish(recognizer: OnlineRecognizer, sid: number, st: StreamState): void {
    const text = recognizer.getResult(st.stream).text ?? '';
    if (text !== st.lastText) {
      const added = text.startsWith(st.lastText) ? text.slice(st.lastText.length) : text;
      st.lastText = text;
      if (added.trim()) this.post({ type: 'delta', sid, text: added });
    }
    if (recognizer.isEndpoint(st.stream)) {
      if (text.trim()) this.post({ type: 'final', sid, text: text.trim() });
      recognizer.reset(st.stream);
      st.lastText = '';
    }
  }
}
