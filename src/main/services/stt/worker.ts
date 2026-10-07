/**
 * The sherpa-onnx recognizer, out of process (docs/22-LOCAL-STT.md §worker).
 *
 * Forked by localRealtimeStt.ts as an Electron `utilityProcess` and bundled
 * by electron-vite to out/main/stt-worker.js (a second rollup input). It is
 * its own process on purpose: the addon is native code and a crash here
 * must not take the main process — and the dashboard, overlay and DB — down
 * with it. The parent restarts it and the UI shows "reconnecting".
 *
 * The recognizer stays loaded between sessions (a model load takes seconds);
 * it reloads only when the model directory changes. It decodes SEVERAL
 * streams at once (streams.ts) — a live session opens one per captured audio
 * stream, the call and the user's microphone — each keyed by the `sid` the
 * parent assigns. Language is a per-stream option on the multilingual model,
 * so a language change is just a new stream.
 */
import { MODEL_SAMPLE_RATE, APP_SAMPLE_RATE } from './pcm';
import { StreamTable } from './streams';
import type { OnlineRecognizer, OnlineStream, Resampler } from './streams';
import type { LoadMessage, WorkerIn, WorkerOut } from './protocol';

interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizer;
  LinearResampler?: new (inputRate: number, outputRate: number) => Resampler;
}

// ---- process wiring ---------------------------------------------------------

type ParentPort = {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
};

const port = (process as unknown as { parentPort: ParentPort }).parentPort;
const post = (m: WorkerOut): void => port.postMessage(m);

let sherpa: SherpaModule | null = null;
let recognizer: OnlineRecognizer | null = null;
let loadedDir = '';
const streams = new StreamTable(post);

function loadAddon(): SherpaModule {
  if (!sherpa) {
    // CommonJS addon, resolved at runtime (externalized by electron-vite).
    sherpa = require('sherpa-onnx-node') as SherpaModule;
  }
  return sherpa;
}

function userSafe(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Never leak a filesystem path to the UI.
  return raw.replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]+/g, '<path>').slice(0, 300);
}

function recognizerConfig(m: LoadMessage): unknown {
  return {
    featConfig: { sampleRate: MODEL_SAMPLE_RATE, featureDim: 128 },
    modelConfig: {
      transducer: { encoder: m.files.encoder, decoder: m.files.decoder, joiner: m.files.joiner },
      tokens: m.files.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    // Endpointing (seconds): rule1 = trailing silence with no text yet, rule2 =
    // trailing silence after some text, rule3 = hard cap on utterance length.
    //
    // These must be comfortably longer than the model's streaming chunk
    // (560 ms for both catalog models). Tokens for a chunk only appear once the
    // whole chunk is decoded, so "trailing silence" as the detector sees it
    // includes up to one chunk of not-yet-decoded speech. With rule2 at 0.6 s
    // a live test cut "the roadmap update" to "the road" and dropped the
    // closing question mark: the endpoint fired mid-utterance and `reset`
    // discarded the audio still in the stream. ≥ 2 chunks after text.
    //
    // Rule 1 is effectively OFF. It fires after N seconds of silence with no
    // text and `reset`s the stream — and in a quiet call that reset lands on
    // the first word of whoever speaks next, clipping it ("Fine, let's…" →
    // "Let's…", "Morning. Have you…" → "Have you…"; 2026-10-06 experiment,
    // 2/10 turns clipped at 2.4 s, 0/10 with the rule off). A silence-only
    // segment never produces a final anyway, so the rule buys nothing here.
    rule1MinTrailingSilence: 60,
    rule2MinTrailingSilence: 1.4,
    rule3MinUtteranceLength: 20,
  };
}

function newStream(m: LoadMessage): OnlineStream {
  if (!recognizer) throw new Error('recognizer not loaded');
  const s = recognizer.createStream();
  if (m.multilingual && m.language) s.setOption('language', m.language);
  return s;
}

/** Each stream gets its own resampler: sherpa's keeps the fractional phase
 *  between frames, and two streams' frames interleave. */
function newResampler(api: SherpaModule): Resampler | null {
  return api.LinearResampler ? new api.LinearResampler(APP_SAMPLE_RATE, MODEL_SAMPLE_RATE) : null;
}

function handleLoad(m: LoadMessage): void {
  const api = loadAddon();
  if (!recognizer || loadedDir !== m.modelDir) {
    // Streams belong to the recognizer that created them — a new model means
    // a fresh table. (In practice the model only changes between sessions.)
    streams.clear();
    recognizer = null; // drop the old one before allocating the next (~1 GB each)
    recognizer = new api.OnlineRecognizer(recognizerConfig(m));
    loadedDir = m.modelDir;
  }
  // sid 0 is a warm-up: the recognizer is what takes seconds, so it is built
  // ahead of the first session; the session's own `load` opens its stream.
  if (m.sid !== 0) streams.open(m.sid, newStream(m), newResampler(api));
  post({ type: 'loaded', sid: m.sid });
}

port.on('message', (e) => {
  const msg = e.data as WorkerIn;
  try {
    switch (msg.type) {
      case 'load':
        handleLoad(msg);
        break;
      case 'audio':
        // Not loaded yet — the parent drops frames until 'loaded'; an unknown
        // sid is a stream already stopped.
        if (recognizer) streams.audio(recognizer, msg.sid, msg.pcm);
        break;
      case 'stop':
        streams.stop(recognizer, msg.sid);
        break;
    }
  } catch (err) {
    post({ type: 'error', sid: msg.sid, message: userSafe(err) });
  }
});

post({ type: 'ready' });
