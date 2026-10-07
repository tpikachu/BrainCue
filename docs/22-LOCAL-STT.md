# 22 · Local speech-to-text

On-device streaming transcription. With the `local` engine nothing a person
says leaves the machine: audio goes from the capture stream to a recognizer
running on the CPU in a child process, and the text comes back the same way
the cloud transcriber's does — deltas while someone speaks, a final when they
pause. The rest of the pipeline (trigger, grounding, generation, the Cue Card)
does not know which engine produced the words.

The engine choice and the model catalog are `shared/stt.ts` (`SttPrefs`,
`LOCAL_STT_MODELS`). Everything that runs is `src/main/services/stt/`.

## Why these models, why this runtime

**Nemotron, not Whisper.** Whisper (and whisper.cpp) is an *offline* model: it
transcribes a finished window of audio, so a "streaming" Whisper is a loop of
overlapping 5–30 s windows with the partial text re-decoded every pass — high
CPU, text that rewrites itself, and a final only after the window closes.
NVIDIA's Nemotron speech models are **cache-aware streaming transducers**
(FastConformer encoder + RNN-T decoder): they consume audio in 560 ms chunks,
carry state between chunks, and emit tokens as they are heard. Partial text
appears within one chunk of speech, finals come from the recognizer's own
endpoint rules, and the encoder does not re-read what it already processed.
For a live companion that acts on completed turns, that difference is the
whole latency story. Both models ship with punctuation and capitalisation.

**sherpa-onnx, not a bespoke ONNX Runtime harness.** sherpa-onnx (k2-fsa) is
the runtime the Nemotron streaming exports are published for; it owns the
feature extraction (128-bin fbank), the chunked encoder cache, greedy
transducer decoding, endpointing, and a linear resampler — all behind a
Node addon (`sherpa-onnx-node`, prebuilt `sherpa-onnx-win-x64` etc.). Writing
that in-house would be months of work to reach parity on a path that is not
the product.

| id | Model | Languages | Size (INT8) | Notes |
|---|---|---|---|---|
| `nemotron-speech-streaming-en-0.6b` | Nemotron Speech Streaming EN 0.6B | English | 662 MB | Recommended default. Strongest English streaming model available on-device. |
| `nemotron-3.5-asr-streaming-0.6b` | Nemotron 3.5 ASR Streaming 0.6B | 40, auto-detected or pinned | 682 MB | Same size and speed. Reads a per-stream `language` option — the profile language is passed in. |

Both are the INT8 exports (encoder / decoder / joiner ONNX + `tokens.txt`)
published on Hugging Face. Each file's **byte size is pinned in the catalog**
(from the blob listing on 2026-09-06). That pin is the manifest: it drives the
progress bar without a round-trip and is the install check (below).

## On disk

```
<userData>/models/stt/<modelId>/
  encoder.int8.onnx
  decoder.int8.onnx
  joiner.int8.onnx
  tokens.txt
  encoder.int8.onnx.part       # only while a download is in flight or was interrupted
```

`modelStore.ts` is the only module that knows this layout:

- `installed(id)` — every catalog file exists at **exactly** its pinned size.
  No hash, no marker file. A model with a `.part` next to complete files is
  still installed if the complete files are all there.
- `bytesOnDisk(id)` — complete files + `.part` remnants, so Settings can say
  "312 MB of 662 MB" before a resume.
- `remove(id)` — deletes the directory. Refuses while a download is active.
- The map of active downloads (one per model) lives here too; it is what
  `stt:list-models` embeds and what `remove` checks.

`isLocalModelInstalled` and `sttReady` in `services/stt/index.ts` are the
read-side seams the rest of main uses (`settings:get` exposes `sttReady`).

## Download, resume, verify (`downloader.ts`)

`stt:download { modelId }` returns `{ started: true }` at once and streams
`SttDownloadProgress` on `stt:download-progress`:

```ts
{ modelId, state: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled',
  receivedBytes, totalBytes, percent, file?, error? }
```

- Files download in catalog order to `<name>.part` with `fetch` (Node's
  global; Hugging Face `resolve` URLs 302 to a CDN and redirects are
  followed). A `.part` left by a cancel or a crash is **resumed** with
  `Range: bytes=<size>-`; a `206` appends, a `200` means the server ignored
  the range and the file restarts, a `416` deletes the remnant and restarts.
- A transfer that drops (socket reset, premature close) is retried up to
  **3 times** with back-off (0.5 s / 1.5 s / 4 s), each retry resuming from
  what is on disk.
- **Verify** = the finished `.part` is exactly the pinned size. Only then is
  it renamed to its final name. A `Content-Length` / `Content-Range` total
  that disagrees with the pin fails immediately (`error`, the remnant is
  deleted) rather than after 650 MB — a size mismatch is definitive and is
  not retried.
- `receivedBytes` counts every file including resumed bytes; `percent` is
  from the catalog total. Ticks are throttled to one per 250 ms, plus one on
  every state or file change.
- `stt:cancel-download` aborts; the state goes to `cancelled` and the `.part`
  **stays** so the next `stt:download` resumes it. A second `stt:download` for
  a model already downloading is a no-op (`{ started: true }`).
- Error text is user-safe (HTTP status or "check your connection"); paths are
  never included.
- When a download reaches `done`, `applySttSelection()` runs, so a user who
  already chose `local` gets it on the next session without a restart.

## The recognizer runs out of process (`worker.ts`)

`sherpa-onnx-node` is native code. It runs in an Electron **utility process**
forked by `localRealtimeStt.ts` (`utilityProcess.fork(out/main/stt-worker.js)`,
a second rollup input in `electron.vite.config.ts`). A crash there cannot take
main — the DB, the overlay, the shortcuts — with it. The parent restarts the
worker once per session and the Cue Card shows *reconnecting*; a second death
ends the session with an error.

Protocol (`protocol.ts`, structured-clone messages over `parentPort`):

| Direction | Message | Meaning |
|---|---|---|
| → worker | `{ type:'load', sid, modelDir, files, language, multilingual }` | Build (or reuse) the recognizer, open a stream for `sid` (`sid` 0 = warm-up, no stream). `language` is set on the stream only for the multilingual model. |
| → worker | `{ type:'audio', sid, pcm: ArrayBuffer }` | PCM16 mono **24 kHz** as the app captures it, for the stream `sid`. The worker converts to Float32 and resamples to 16 kHz (`LinearResampler` per stream, or the pure fallback in `pcm.ts`). |
| → worker | `{ type:'stop', sid }` | `inputFinished()` on that stream only, decode what is left, flush it as a final, forget it. Always answered with `stopped`. |
| ← worker | `ready` · `loaded {sid}` · `delta {sid,text}` · `final {sid,text}` · `stopped {sid}` · `error {sid,message}` | Every output echoes the stream id so the host routes it to that stream's callbacks and a late message from a stream already closed is dropped. |

Recognizer config (all models in the catalog share it):

```ts
{ featConfig: { sampleRate: 16000, featureDim: 128 },
  modelConfig: { transducer: { encoder, decoder, joiner }, tokens, numThreads: 2, provider: 'cpu', debug: 0 },
  decodingMethod: 'greedy_search', enableEndpoint: true,
  rule1MinTrailingSilence: 60, rule2MinTrailingSilence: 1.4, rule3MinUtteranceLength: 20 }
```

Per audio message: `acceptWaveform` → `while (isReady) decode` → `getResult().text`;
if the text changed, `delta` with **only the words added since the last
delta** (the cloud transcriber's contract — the dashboard store and the Cue
Card append deltas into one in-flight line, so a full-text delta would read
"MorningMorning. Have you had…"; greedy decoding never retracts a token, so
the result always extends the previous one); if `isEndpoint`, `final` with the
whole text and `reset(stream)`. The **endpoint rules** are sherpa-onnx's: rule 2
fires after 1.4 s of silence once there is text (this is the one that ends a
normal utterance), rule 3 caps an utterance at 20 s so a monologue still
produces finals the pipeline can act on, and rule 1 (silence with no text yet)
is set to 60 s, i.e. **off**.

Why rule 1 is off: it `reset`s the stream after N seconds of silence with no
text, and in a quiet call that reset lands on the first word of whoever speaks
next and clips it. The 2026-10-06 experiment (ten TTS turns fed straight into
sherpa-onnx with 2.5–6 s gaps) lost the opening word of 2/10 turns at 2.4 s
("Fine, let's decide next week" → "Let's decide next week", "Morning. Have
you had…" → "Have you had…") and 0/10 with the rule off; a user's transcript
showed the same pattern. A silence-only segment never produces a final, so the
rule had nothing to offer here. Turns closer together than rule 2's 1.4 s
still merge into one final; that is the trade for not cutting sentences.

Why not the cloud transcriber's 600 ms? Both catalog models decode in 560 ms
chunks, and tokens for a chunk only appear once the whole chunk is decoded, so
the "trailing silence" the endpoint detector sees includes up to one chunk of
speech that has not been decoded yet. At 0.6 s the endpoint fired mid-sentence
(the 2026-09-07 live test cut "the roadmap update" to "the road" and lost the
closing "?") and `reset` threw away the audio still in the stream. Rule 2 must
be at least two chunks, rule 1 at least four. The trade is ~0.8 s more latency
per turn; the unpunctuated-question heuristic in `meetingHeuristics.ts` gets
that back on the trigger path, since a final without a "?" no longer pays a
classifier round trip.

The recognizer stays **loaded between sessions** (a load takes seconds and
~1 GB of RAM); it is rebuilt only when the model directory changes. A language
change is just a new stream.

### Several streams on one recognizer (2026-09-07)

A live session hears the call AND the user's microphone (06 §realtime), so the
worker decodes **several streams at once** on the one loaded recognizer. The
stream table (`streams.ts`, pure — tested with a fake recognizer in
`streams.test.ts`) maps `sid → { stream, lastText, resampler }`: every stream
keeps its own decoder state, its own stateful `LinearResampler` (two streams'
frames interleave, and the resampler carries fractional phase between frames)
and its own "last published text", so the deltas, endpoints and finals of the
call and the mic never bleed into each other. In the protocol this means:

- `audio` carries the `sid` of the stream a frame belongs to (an unknown sid —
  a stream already stopped — is dropped, not misrouted);
- `stop { sid }` flushes and forgets **only** that stream; the other keeps
  decoding;
- `load` with `sid` 0 is a warm-up: it builds the recognizer and opens no
  stream. A session's own `load` opens its stream (replacing a stale one of
  the same sid after a worker restart);
- a model change (`modelDir` differs) clears the table — streams belong to
  the recognizer that created them. In practice that only happens between
  sessions.

## The provider (`localRealtimeStt.ts`)

`localRealtimeStt` implements `RealtimeSttProvider` — the same interface the
OpenAI Realtime transcriber implements — and is registered as provider
`local` for the `realtimeStt` capability. The host (`SttWorkerHost`) holds a
map `sid → session` and allows **any number of concurrent sessions** on the
one worker — a live session opens two (the call and the mic); each `open()`
gets its own sid, `load` and callbacks. `applySttSelection()` (startup,
every `settings:set` with `stt`, download done, model deleted) selects
`local` only when `prefs.engine === 'local'` **and** the model is installed;
otherwise `openai`. So a half-downloaded model never produces a session that
cannot start — it quietly uses the cloud engine, and `sttReady` tells the UI.

- `open(cb, { language })` throws a clear error when the model is not
  installed. Otherwise it forks the worker lazily, sends `load`, and calls
  `onStatus('connected')` on `loaded`.
- Audio arriving before `loaded` is dropped; the first dropped frame emits one
  `onStatus('reconnecting')` so the Cue Card shows the model is loading.
- `delta` → `onDelta`, `final` → `onFinal`, `error` → `onError`.
- `stop()` sends `stop` for that sid; the flushed final still reaches the
  callbacks, and the other session is untouched.
- If the worker dies mid-session it is restarted **once**, and every open
  session's `load` is re-sent on the new process with its `reconnecting`
  status re-announced. A session that has already been through one restart
  ends with an error instead. `warmUp()` is a no-op while any session is open.

## Known limits

- **CPU.** Two ONNX Runtime threads decode continuously while a session is
  live — roughly one core on a modern laptop; on older CPUs expect fan noise.
  No GPU provider is wired (`provider: 'cpu'`).
- **First load** takes a few seconds (deserialising ~650 MB of INT8 weights);
  the Cue Card shows *reconnecting* until the first frames are accepted.
  Later sessions reuse the loaded recognizer.
- **Greedy decoding only.** `modified_beam_search` is available in sherpa-onnx
  but costs CPU for a small accuracy gain; not exposed.
- **Two streams cost two decodes.** Each open stream runs the same two
  ONNX Runtime threads' worth of work; a call (system + mic) is roughly twice
  the CPU of a solo session.
- **Windows x64 is the verified platform.** The addon publishes macOS and
  Linux builds as optional dependencies and the code is platform-neutral, but
  only `sherpa-onnx-win-x64` has been loaded here. `electron-builder.yml`
  unpacks `node_modules/sherpa-onnx-*/**` from the asar so the `.node` and
  the onnxruntime DLLs are real files.
- **RAM.** Loaded model ≈ 1 GB in the worker process.
- Downloads come from Hugging Face; a corporate proxy that rewrites
  `Content-Length` will surface as a size-mismatch error.

## Settings UI

Settings → **Speech-to-Text** (`/settings/speech`, `renderer/dashboard/pages/settings/SpeechPanel.tsx`) is the whole user surface. An **Engine** chooser (Cloud Providers / Local) writes `stt.engine`; the header badge shows `sttReady` — choosing Local with nothing installed is allowed and reads *not ready* rather than being refused, and the panel says to download a model. The Local tab lists `LOCAL_STT_MODELS` from the catalog with install state from `stt:list-models`: **Download** (not installed), a percentage + **Cancel** (in flight, from `EVENTS.sttDownloadProgress`), **Active** (installed and selected — `stt.localModelId`), **Use** (installed, not selected), and a two-click delete. Terminal progress states refresh the list and re-read settings so the badge follows. Because a download outlives the page, the shell also shows it: `renderer/dashboard/DownloadStrip.tsx` under the title bar (seeded from the same list on mount) with the file caption, a real bar, received / total, Cancel, a brief *Model ready*, and an error row with Retry.

## Adding a model

1. Find the sherpa-onnx export on Hugging Face (encoder/decoder/joiner +
   tokens; a transducer with 128-bin features at 16 kHz — the worker config
   is shared).
2. Add an entry to `LOCAL_STT_MODELS` in `shared/stt.ts`: a stable `id`
   (never renamed — it is the directory name on disk and the value in
   `SttPrefs`), the four files with `resolve/main` URLs and their **exact
   byte sizes** from the blob listing, `languages`, `chunkMs`.
3. If the model is multilingual, `languages: 'multilingual'` makes the
   provider pass the profile language as the stream option.
4. Nothing else changes: the catalog drives Settings, the downloader, the
   install check and the worker's file paths.

## Tests

`src/main/services/stt/*.test.ts` — the downloader against a local
`http.createServer` fixture with Range support (full download through a
redirect, resume from a `.part`, 200-instead-of-206 restart, size mismatch,
cancel mid-stream keeps the `.part` and the next run resumes it, retry after a
dropped connection, retry budget exhausted, HTTP status surfaced);
`installed()` / `bytesOnDisk()` / one-download-per-model / `remove()` refusal
with `electron.app.getPath` mocked; the PCM16 → Float32 and 24k → 16k
helpers in `pcm.ts`, which are pure so they test without the addon; and the
worker's stream table (`streams.test.ts`) driven with a scripted recognizer —
two sids interleaving deltas, an endpoint on one stream finalling and
resetting only that stream, `stop` flushing one and leaving the other decoding.
