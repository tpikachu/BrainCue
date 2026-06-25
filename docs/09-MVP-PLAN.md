# MVP Implementation Plan

Incremental milestones. Each is independently runnable/testable. The skeleton in
this repo delivers M0 and the scaffolding for M1–M2.

## M0 — Skeleton & plumbing  ✅ (this commit)
- electron-vite project (main + preload + 2 renderers) boots.
- Secure window prefs; dashboard + lazy overlay window.
- IPC framework (typed channels, zod-validated `handle()` wrapper, `Result<T>`).
- SQLite + Drizzle init + migration runner; schema defined.
- `ApiKeyStore` (safeStorage) + `settings:set/get/test-api-key`.
- OpenAI client skeleton + models config.
- Tailwind + Zustand wired; Settings page can save/test the key.

## M1 — Profiles & documents  ✅ (implemented)
- Profiles CRUD UI + store.
- Document import (native file picker + paste); local extraction (pdf/docx/txt/md).
- OpenAI structured parsing → store parsed JSON.
- Chunker + embeddings + `vectorStore` persistence (auto re-index on import/notes).
- Top-k retrieval (`services/rag/retriever.ts`) — an internal service call, not an IPC channel.
- UI: `ProfileEditorPage` (resume/JD upload + paste + parse, notes).

## M2 — Live session core  ✅ (implemented)
- Session start/stop/pause; `sessionManager` state machine.
- Mic capture in renderer (`useMicCapture`, segmented MediaRecorder) → audio
  chunks via IPC; main approves only `media` permission.
- Chunked STT → transcript deltas pushed to dashboard + overlay.
- Question detection/classification gate.
- RAG + streaming grounded answer → overlay.
- Persist transcript, questions, answers.
- Remaining polish: speaker diarization, overlap handling.

## Transcription engine upgrade  ✅
- OpenAI **Realtime API** streaming STT (`gpt-4o-transcribe`, server-side VAD):
  live partial deltas + precise finalized turns ([realtime.ts](../src/main/services/openai/realtime.ts)).
- WebSocket opened from the **main process** with the key (never the renderer);
  renderer streams PCM16 24kHz mono via a one-way IPC (`session:realtime-audio`).
- **Audio source selection**: System audio (loopback) to transcribe the
  interviewer in online calls, or Microphone for in-person — via
  `setDisplayMediaRequestHandler({ audio: 'loopback' })`.
- Live interim transcript in the session UI; chunked STT kept as fallback.

## M3 — Overlay polish  ✅ (implemented)
- Compact/expanded, opacity slider, font size, pause/resume (active-session +
  hotkey), show/hide hotkey, click-through toggle.
- Streaming indicator; talking points / resume match / follow-up (expanded mode);
  risk warning banner.
- "Data sent to OpenAI" transparency panel (shows retrieved chunks + scores) via
  the new `session:context` event.

## M4 — Coding / screenshot mode  ✅ (implemented)
- Solve from clipboard text (`Ctrl+Shift+Enter` or "Solve from clipboard") →
  `coding.solveFromOcr` streaming to the overlay.
- Region path: `Ctrl+Shift+S` / "Select region" → captures the primary screen,
  opens a transparent full-screen `selection` window; drag-select → crop the
  frozen frame (canvas, devicePixelRatio-aware) → `vision.solveFromImage`.
- Esc cancels; empty input and errors are surfaced in the selector banner.
- Later: multi-display selection.

## M5 — Reports & privacy  ✅ (implemented)
- Reports page: view/generate session coaching reports (summary, strengths,
  improvements, per-question) with loading + error states.
- Privacy Mode ON by default (`setContentProtection` on overlay + selector),
  togglable from the overlay header and Settings, with compliance reminder.
- Data deletion: profiles (cascade), sessions, documents, notes.

## UI / UX pass  ✅
- Shared UI kit (`components/ui.tsx`): Button, Card, Badge, Field, inputs,
  Spinner, PageHeader, BusyOverlay.
- Profile editor handles the **resume** only (`documents:save-resume`,
  `documents:extract-file`) with a blocking spinner; decoupled from key presence
  so saving always works. JD entry moved to the per-job flow (see below).
- Consistent layout across Profiles, Session, Reports, Settings + sidebar.

## Profiles ↔ Jobs model  ✅
- A **profile** is the candidate (resume + notes + defaults) and is **reusable
  across many jobs**. A new **`jobs`** table holds each target role's JD +
  parsed JSON, added/parsed independently of the resume.
- Resume and each JD are parsed **one at a time** (`documents:save-resume`,
  `jobs:save`); JD is optional and can be added later.
- A job can carry an optional **JD link** (`jobs.jdUrl`): paste a job-posting URL
  and "Fetch" (`documents:fetch-url`) best-effort downloads + strips it to text;
  the link itself is stored for reference (clickable) but not parsed. If the link
  can't be fetched, the user is prompted to paste the JD manually.
- A job can also carry an optional **company website** (`jobs.companyUrl`): on
  save the app scrapes the site (`services/documents/companyResearch.ts`), parses
  it (`parseCompany`) into `jobs.parsedCompany`, and indexes it as `company`
  chunks scoped to the job — so answers can speak to the company. Best-effort;
  failures surface as `companyError` and don't fail the save.
- Chunks carry an optional `jobId`; retrieval always includes resume/notes and,
  when a session/mock selects a job, that job's JD chunks too
  (`sessions.jobId`, `retrieve(..., jobId)`).
- Session + Mock setup expose an optional **Job** selector.

## Onboarding tour  ✅
- First-run guided tour (`dashboard/Tour.tsx`, `useTourStore`) spotlights the
  sidebar to walk through key → profile → interview → overlay → reports.
- Completion/skip persists `settings.tourDone`; replayable from Settings →
  Getting started.

## M6 — Packaging & later
- electron-builder Windows/macOS/Linux targets; app icon generated from
  `resources/icon.svg`; pre-package clean step (`scripts/clean-release.mjs`).
- Realtime transcription and Vision (image solve) are now implemented.
- Later: user-rebindable hotkeys; multi-display capture; vector store swap to
  LanceDB/sqlite-vec.

## Definition of done per milestone
- Typecheck passes (`npm run typecheck`).
- App boots and the milestone's primary flow works end-to-end.
- No API key in renderer, logs, or repo.

## Commands
```
npm install
npm run dev          # electron-vite dev (HMR for renderer)
npm run typecheck
npm run db:generate  # drizzle-kit generate migrations from schema
npm run build        # type build + bundle
npm run package      # electron-builder
```
