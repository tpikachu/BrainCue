# BrainCue Copilot

A desktop (Electron) interview assistant. **Local-first data, bring-your-own
OpenAI key.** It transcribes interviews, detects questions, and surfaces
grounded answer suggestions in a floating, always-on-top **Cue Card** using your
resume / job description / notes (local RAG).

> Use this only where AI assistance is permitted. Your data stays on your
> machine; only the retrieved context + question is sent to OpenAI.

## System requirements

BrainCue Copilot is a local desktop app that streams live audio to OpenAI for
transcription and answers, so a steady internet connection and a microphone
matter more than raw compute.

| | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 10 64-bit (version 2004 / build 19041+), macOS 11, or a modern 64-bit Linux | Windows 11, macOS 13+ |
| **CPU** | Dual-core x64 / Apple Silicon | Quad-core or better |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | ~600 MB (app) + room for local data | 2 GB+ free (profiles, vectors, transcripts) |
| **GPU** | Any (integrated is fine) | Discrete or modern integrated |
| **Display** | 1280 × 800 | 1920 × 1080 or larger |
| **Audio** | Microphone | Mic + system-audio loopback (to hear the interviewer) |
| **Network** | Broadband internet | Low-latency broadband (for real-time transcription) |

You also need your **own OpenAI API key** (set in Settings) and an OpenAI account
with access to the models in use (Realtime/STT, Responses, embeddings, TTS, Vision).

**Notes**
- **Privacy Mode** (hiding the app from screen sharing/recording) is most reliable
  on **Windows 10 version 2004+** and Windows 11; on older builds the window may
  show as black to viewers instead of being cleanly excluded.
- **System-audio capture** (the interviewer's voice in online calls) uses Windows
  loopback automatically. On **macOS**, capturing system audio needs a virtual
  audio device (e.g. BlackHole); the microphone path works without one.
- **Hybrid-GPU laptops** (e.g. NVIDIA Optimus): if a window shows up blank/black,
  launch with `--disable-gpu` (or set `AI_DISABLE_GPU=1`) to fall back to software
  rendering.

## Stack
Electron · React · TypeScript · Vite (electron-vite) · TailwindCSS · Zustand ·
SQLite (better-sqlite3) · Drizzle ORM · OpenAI Node SDK (Responses, embeddings,
STT/Realtime, TTS, Vision) · electron-builder.

## Design docs
See [`docs/`](docs/):
1. [PRD](docs/01-PRD.md)
2. [Architecture](docs/02-ARCHITECTURE.md)
3. [Windows (main/renderer/overlay)](docs/03-WINDOWS.md)
4. [Database schema](docs/04-DATABASE.md)
5. [IPC map](docs/05-IPC-MAP.md)
6. [OpenAI service layer](docs/06-OPENAI-SERVICE.md)
7. [API key security](docs/07-API-KEY-SECURITY.md)
8. [Folder structure](docs/08-FOLDER-STRUCTURE.md)
9. [MVP plan](docs/09-MVP-PLAN.md)

## Getting started
```bash
npm install
cp .env.example .env      # optional: put OPENAI_API_KEY for dev
npm run db:generate       # generate the initial Drizzle migration
npm run dev               # launch the app with HMR
```
In production you set the key in **Settings** (encrypted via OS secure storage).

## Scripts
| Script | Purpose |
|---|---|
| `npm run dev` | electron-vite dev (HMR) |
| `npm run typecheck` | type-check main + renderer |
| `npm run db:generate` | generate SQL migrations from the Drizzle schema |
| `npm run build` | typecheck + bundle |
| `npm run icon` | regenerate app icons from `resources/icon.svg` |
| `npm run package` / `package:win` / `package:mac` | build installer via electron-builder (auto-cleans `release/` + kills running app first) |

## Security invariants
- The OpenAI key lives **only** in the main process; the renderer learns a
  boolean `apiKeyPresent` and nothing more.
- All OpenAI/DB/secret access happens in main; the renderer talks via the typed
  `window.api` preload bridge.
- `.env` is gitignored; the key is never logged (logger redacts `sk-…`).

## Status
Skeleton implements M0 (plumbing) and most of the M1/M2 service layer. See
[docs/09-MVP-PLAN.md](docs/09-MVP-PLAN.md). Items marked in code as M1/M2/M4 are
where the remaining UI wiring lands.
