/**
 * Speech-to-text engine choice + the catalog of on-device models.
 *
 * Two engines. `cloud` is the OpenAI Realtime transcriber the app shipped
 * with — accurate, needs a key, every syllable leaves the machine, and a turn
 * is final only ~600 ms after the speaker stops. `local` runs an NVIDIA
 * cache-aware streaming transducer on the CPU through the sherpa-onnx runtime:
 * nothing leaves the machine, partial text lands within a chunk of speech, and
 * the ~630 MB model is downloaded once from Hugging Face into userData.
 *
 * The catalog is data the renderer needs before any download exists (names,
 * sizes, what each is for), so it lives in shared/. Install state does not —
 * that comes from main over `stt:list-models`.
 *
 * Both models are the sherpa-onnx INT8 exports (encoder/decoder/joiner +
 * tokens). File sizes are pinned from the Hugging Face blob listing on
 * 2026-09-06 so the download manager can show a real progress bar and verify
 * a complete file without a manifest round-trip.
 */

export type SttEngine = 'cloud' | 'local';

export interface SttPrefs {
  engine: SttEngine;
  /** Which catalog entry the local engine runs. Always set (defaults to the
   *  recommended model) so switching to `local` never has a null to resolve. */
  localModelId: string;
}

export interface LocalSttModelFile {
  /** File name inside the model directory (also what sherpa-onnx is pointed at). */
  name: string;
  url: string;
  bytes: number;
}

export interface LocalSttModel {
  id: string;
  name: string;
  vendor: 'NVIDIA';
  /** What the model transcribes. `multilingual` auto-detects per stream. */
  languages: 'en' | 'multilingual';
  description: string;
  /** Streaming chunk the export was made for — roughly the partial-text delay. */
  chunkMs: number;
  /** sherpa-onnx feature config for this model family. */
  sampleRate: 16000;
  featureDim: 128;
  totalBytes: number;
  files: LocalSttModelFile[];
  recommended?: boolean;
}

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;

const EN_REPO = 'csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14';
const ML_REPO = 'csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';

const model = (
  m: Omit<LocalSttModel, 'totalBytes' | 'sampleRate' | 'featureDim' | 'vendor'>,
): LocalSttModel => ({
  ...m,
  vendor: 'NVIDIA',
  sampleRate: 16000,
  featureDim: 128,
  totalBytes: m.files.reduce((n, f) => n + f.bytes, 0),
});

export const LOCAL_STT_MODELS: LocalSttModel[] = [
  model({
    id: 'nemotron-speech-streaming-en-0.6b',
    name: 'Nemotron Speech Streaming EN 0.6B',
    languages: 'en',
    description:
      'English only. The strongest English streaming model available on-device — punctuation and capitalization built in.',
    chunkMs: 560,
    recommended: true,
    files: [
      { name: 'encoder.int8.onnx', url: hf(EN_REPO, 'encoder.int8.onnx'), bytes: 652_916_830 },
      { name: 'decoder.int8.onnx', url: hf(EN_REPO, 'decoder.int8.onnx'), bytes: 7_257_753 },
      { name: 'joiner.int8.onnx', url: hf(EN_REPO, 'joiner.int8.onnx'), bytes: 1_735_862 },
      { name: 'tokens.txt', url: hf(EN_REPO, 'tokens.txt'), bytes: 8_952 },
    ],
  }),
  model({
    id: 'nemotron-3.5-asr-streaming-0.6b',
    name: 'Nemotron 3.5 ASR Streaming 0.6B',
    languages: 'multilingual',
    description:
      '40 languages with automatic detection, or pinned to the profile language. Same size and speed as the English model.',
    chunkMs: 560,
    files: [
      { name: 'encoder.int8.onnx', url: hf(ML_REPO, 'encoder.int8.onnx'), bytes: 657_601_403 },
      { name: 'decoder.int8.onnx', url: hf(ML_REPO, 'decoder.int8.onnx'), bytes: 14_978_075 },
      { name: 'joiner.int8.onnx', url: hf(ML_REPO, 'joiner.int8.onnx'), bytes: 9_504_438 },
      { name: 'tokens.txt', url: hf(ML_REPO, 'tokens.txt'), bytes: 131_440 },
    ],
  }),
];

export const DEFAULT_LOCAL_STT_MODEL_ID = LOCAL_STT_MODELS[0].id;

export const DEFAULT_STT_PREFS: SttPrefs = { engine: 'cloud', localModelId: DEFAULT_LOCAL_STT_MODEL_ID };

export function localSttModel(id: string): LocalSttModel | undefined {
  return LOCAL_STT_MODELS.find((m) => m.id === id);
}

/** Human-readable size, e.g. "631 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
