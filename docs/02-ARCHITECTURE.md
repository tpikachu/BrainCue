# Technical Architecture

## 1. High-level

```
┌──────────────────────────────────────────────────────────────────┐
│                          Electron App                              │
│                                                                    │
│  ┌────────────────────┐         ┌──────────────────────────────┐  │
│  │   MAIN PROCESS     │  IPC     │        RENDERER(S)           │  │
│  │  (Node.js, trusted)│◀────────▶│  (Chromium, sandboxed)       │  │
│  │                    │ preload  │                              │  │
│  │ • app lifecycle    │ bridge   │  ┌────────────────────────┐  │  │
│  │ • window mgmt      │          │  │ Dashboard window (React)│  │  │
│  │ • global shortcuts │          │  └────────────────────────┘  │  │
│  │ • screenshot       │          │  ┌────────────────────────┐  │  │
│  │ • OpenAI calls ◀───┼── only   │  │ Overlay window (React)  │  │  │
│  │ • SQLite/Drizzle   │   here   │  └────────────────────────┘  │  │
│  │ • API key (safeStorage)       │                              │  │
│  │ • RAG retrieval    │          │  Zustand stores, Tailwind UI │  │
│  └────────────────────┘         └──────────────────────────────┘  │
│            │                                                       │
│            ▼                                                       │
│   userData/  ├─ app.db (SQLite)                                    │
│              ├─ documents/ (original uploads)                      │
│              └─ vectors/   (LanceDB or in-db vectors)             │
└──────────────────────────────────────────────────────────────────┘
                         │  HTTPS (only from main)
                         ▼
                    OpenAI API
```

**Golden rule:** all network/AI/database/secret access lives in the **main
process**. The renderer is treated as untrusted and reaches the main process
only through a typed, allow-listed preload bridge.

## 2. Core stack

| Concern | Choice |
|---|---|
| Shell | Electron |
| UI | React + TypeScript |
| Bundler/dev | Vite (via `electron-vite`) |
| Styling | TailwindCSS |
| Renderer state | Zustand |
| DB | SQLite via `better-sqlite3` |
| ORM/migrations | Drizzle ORM + drizzle-kit |
| Vectors | MVP: vectors stored in SQLite (JSON/BLOB) + in-process cosine search. Scale path: LanceDB or `sqlite-vec` extension. |
| AI | OpenAI Node SDK — Responses API, embeddings, STT/transcription, Realtime, TTS |
| Coding-from-image | OpenAI Vision (no local OCR dependency) |
| Packaging | electron-builder |

> **Vector decision for MVP:** brute-force cosine over stored embeddings in
> SQLite. Resume+notes per profile plus JD+company-research per job = a few
> hundred chunks max, so in-memory
> cosine is sub-millisecond and avoids native-extension/packaging friction.
> The retriever is an interface (`VectorStore`) so we can swap in LanceDB or
> `sqlite-vec` without touching callers.

## 3. Process responsibilities

### Main process
App lifecycle; create/destroy windows; always-on-top & content protection;
register/unregister global shortcuts; `desktopCapturer` + region crop; coordinate
audio capture (renderer captures raw audio, main makes the STT call); store &
read API key via `safeStorage`; own the OpenAI client; own the DB; perform RAG;
register all IPC handlers.

### Renderer — Dashboard
All management UI: profiles, document upload, notes, session setup, live
transcript mirror, settings, reports. Talks only via `window.api.*`.

### Renderer — Overlay
Frameless transparent React app. Subscribes to streamed answer/transcript events
pushed from main. Controls: opacity, font size, compact/expanded, pause/resume.

### Preload
`contextBridge` exposes a single typed `window.api` object that forwards to
`ipcRenderer.invoke` (request/response) and `ipcRenderer.on` (events). No Node
APIs or the OpenAI key are ever exposed.

## 4. The conversation engine (v2)

The live pipeline lives in `services/engine/` — one engine, configured by
**ModeDefinitions** (modes may only configure it, never fork it):

```
services/engine/
  engine.ts             // singleton: the ONE active session, lifecycle, sources
  engineSession.ts      // generic flow: ContextEvent → trigger → grounding →
                        //   generation → contribution → persistence/surfaces
                        //   (owns the answer-slot/abort concurrency rules)
  contextEvent.ts       // normalized inputs (transcript_final, direct_ask, …)
  modeDefinition.ts     // what a mode may declare (sources, trigger, persona…)
  grounding.ts          // top-k retrieval over profile + context pack
  sourceAdapter.ts      // realtime transcriber wiring + PCM level
  trigger/              // TriggerPolicy: reactiveQuestion (classifier + 0.4
                        //   floor), summoned (direct ask) — deterministic
                        //   gates around LLM classification
  modes/interview.mode.ts  // Interview Copilot as configuration
  persistence/enginePersistence.ts  // interview tables (v1 semantics, pinned
                        //   by parity tests) + generic `contributions` dual-write
```

`services/session/sessionManager.ts` remains as a **backward-compatible
facade** — IPC handlers, mock/sparring, and the coding solver call it
unchanged; `sessionManager.parity.test.ts` pins the extraction.

Data flow — live answer (happy path):
1. Renderer captures mic/loopback audio → streams PCM16 via one-way IPC.
2. Engine feeds the Realtime transcriber; finalized turns become
   `transcript_final` ContextEvents (persisted + broadcast).
3. The mode's trigger policy decides (interview: classifier-confirmed question
   at ≥0.4 confidence; direct asks use the summoned policy).
4. Grounding: embed the question → `VectorStore.search()` top-k over profile +
   the session's context pack (transparency event carries exactly what's sent).
5. The mode's `generate()` streams the grounded answer (Responses API);
   tokens forward to the overlay via IPC.
6. Persistence: question + answer (v1 tables) **and** a generic
   `contributions` row with provenance (question + chunk refs).

## 5. OpenAI service layer

A thin internal service module (main only) wraps the SDK:

```
services/openai/
  client.ts          // lazily-built OpenAI client from decrypted key
  models.ts          // central model id config (Responses, embeddings, STT, TTS, vision)
  parsing.ts         // resume/JD/company → structured JSON (parseResume/parseJobDescription/parseCompany)
  embeddings.ts      // embed(texts[]) -> Float32Array[]
  answer.ts          // streamAnswer(question, context, profile) -> async iterator
  questions.ts       // classifyQuestion(text) -> {type, confidence, strategy}
  transcription.ts   // transcribeChunk(audio) -> text
  realtime.ts        // RealtimeTranscriber: delta-level STT (+ realtimeEvents.ts)
  coding.ts/vision.ts// solveFromOcr(text) / solveFromImage(image) -> coding solution
  interviewer.ts     // generateQuestion(...) for mock interviews
  tts.ts             // speak(text, voice) -> audio Buffer (mock interviewer)
```

Cross-cutting: central model config, retry/backoff, error normalization,
token/cost estimation, and a single place that reads the decrypted key.
The engine reaches these through `modes/interview.mode.ts` and the trigger
policies — the provider-capability seam (PRD §6.7) cuts exactly at these call
sites in the next phase.

## 6. API key security (summary; full plan in 07)

- Dev: read `OPENAI_API_KEY` from env.
- Prod: user pastes key → encrypted with Electron `safeStorage` → stored in DB
  (`settings`) as ciphertext. Decrypted only in main, only in memory, at call
  time. Never sent over IPC, never logged, never committed. `keytar` is an
  optional alternative backend behind the same interface.

## 7. Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Strict CSP in renderer HTML; no remote code.
- IPC handlers validate every payload (zod) and are explicitly allow-listed.
- Overlay uses `setContentProtection(true)` in Privacy Mode.
