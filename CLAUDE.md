# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BrainCue** — a local-first desktop AI companion for live conversations (Electron + React + TypeScript). It transcribes what it hears in real time (with consent), decides when it can help, and streams grounded cues into a floating, screen-share-invisible overlay ("Cue Card"). It archives each conversation so the next one starts where the last ended, and holds reviewed long-term memory per profile. Data stays on the user's machine; only retrieved context + the current question go to OpenAI (BYO key).

**Interviews are one activity, not the product.** Interview Copilot and Practice are still fully shipped, but meetings and solo sessions are the daily cases — when you touch a shared path (prompts, retrieval, session defaults), check that it doesn't assume an interview. See [docs/00-VISION.md](docs/00-VISION.md) and [docs/16-CONTINUITY.md](docs/16-CONTINUITY.md).

**One profile at a time.** The dashboard is scoped by `AppSettings.activeProfileId`, chosen in the sidebar switcher and resolved in main (`shared/activeProfile.ts`) so every window agrees. Profile-scoped surfaces read it — never add another profile `<Select>` to a page. See [docs/19-ACTIVE-PROFILE.md](docs/19-ACTIVE-PROFILE.md).

**The user picks an activity, never a mode.** `shared/activities.ts` is the one catalog: what a call IS (meeting/project/job/subject/personal/game/solo/custom), what a Space is a saved instance of, and which `SessionMode` the engine derives from it. There used to be two lists answering the same question and they could disagree. Never add a mode picker back to a start surface; add an activity. See [docs/18-ACTIVITIES.md](docs/18-ACTIVITIES.md).

**A Space is where a conversation is kept.** `archiveSession` and `extractMemoryCandidates` both return 0 when `sessions.packId` is null — no Space, no summary, no memory. The start modal offers only the Spaces of the chosen activity (`spacesFor`) and says what will survive the session before it starts; the save prompt offers the choice once more and files the session before either half runs. Exactly one activity refuses to start without one (`ActivityConfig.needsSpace`, `job`). See [docs/16-CONTINUITY.md](docs/16-CONTINUITY.md) §15.

## Commands

```bash
npm run dev            # electron-vite dev (HMR for all three processes)
npm run build          # typecheck + electron-vite build  (run before committing)
npm run typecheck      # node + web tsconfigs (no emit)
npm run test           # vitest run  ·  single file: npx vitest run src/path/to/x.test.ts
npm run db:generate    # generate a Drizzle migration after editing src/main/db/schema.ts
npm run package:win    # build + electron-builder installer (also :mac, or bare `package`)
```

- `dev`/`start`/`build` all go through `scripts/run-electron-vite.mjs` (a wrapper that strips `ELECTRON_RUN_AS_NODE` and normalizes a lowercase Windows drive letter in cwd — the cause of the old transient rollup "error during build") — invoke them via npm, not electron-vite directly.
- After changing `schema.ts`, always `npm run db:generate` and commit the new `drizzle/*.sql` + `drizzle/meta` snapshot.

## Architecture (the big picture)

**Three processes, one renderer bundle.** Main (`src/main`), preload (`src/preload`), renderer (`src/renderer`). There is a single `index.html`; it renders one of three views chosen by a `?view=` query param (see `src/renderer/main.tsx`):
- **dashboard** (default) — the main window; uses `HashRouter` (`#/profiles`, `#/session`, …).
- **overlay** — the always-on-top, click-through "Cue Card" where answers stream.
- **selection** — the opaque region-capture window.

Each window is created in `src/main/windows/*` and loaded via `loadRenderer.ts`.

**IPC is the contract between renderer and main — follow it exactly:**
- Channel + event names are centralized as `IPC` and `EVENTS` constants in `src/shared/ipc.ts`. Never hardcode channel strings.
- Request/response handlers are registered with `handle(channel, zodSchema, fn)` (`src/main/ipc/helpers.ts`). It validates input with zod and returns a uniform `Result<T>` envelope; errors are normalized/redacted, never thrown across the wire.
- The renderer never touches `ipcRenderer` directly. `src/preload/index.ts` exposes a typed `window.api` facade that unwraps the `Result` envelope (so renderer code uses normal try/catch). Adding an IPC = add to `IPC`/`EVENTS` → add a `handle()` in `src/main/ipc/*.ipc.ts` → add a method to the preload `api` object.
- Main→renderer pushes use `broadcast(EVENTS.x, payload)`; the renderer subscribes via `api.events.onX(cb)` (returns an unsubscribe fn).
- Path aliases: `@shared`, `@main`, `@renderer`. Shared types live in `src/shared/types.ts`.

**State (renderer):** Zustand stores in `src/renderer/store` — notably `useLiveSession` (the live session, transcript, and mic capture live here, in a *global* store, so they survive page navigation; do not move session state back into component state).

**Data:** better-sqlite3 (native, rebuilt for Electron's ABI via `postinstall`) + Drizzle ORM. Schema in `src/main/db/schema.ts`; access only through repositories in `src/main/db/repositories/*.repo.ts`. Migrations in `drizzle/`. Use server-side pagination (LIMIT/OFFSET + count) for any list that can grow large (see `jobsRepo.page()`).

**OpenAI services (`src/main/services/openai`):** transcription uses the **Realtime GA** API over `ws` (the Beta API was retired — do not reintroduce `OpenAI-Beta` headers or `transcription_session.update`). `answer.ts` streams grounded answers; RAG retrieval (`services/rag`) pulls the top profile/JD/company chunks for the current question. The session pipeline (audio → transcription → question classification → retrieve → stream answer → broadcast) lives in `src/main/services/session/sessionManager.ts`.

**Security model:** the OpenAI key lives only in the main process (encrypted at rest) and is never sent to the renderer — IPC returns booleans/data, never the key. **Privacy Mode** (`setContentProtection` / WDA_EXCLUDEFROMCAPTURE) excludes app windows from screen capture; note this also blocks programmatic screenshots of the app.

**Versioning & release notes are a single source of truth:** `changelog/<semver>.md` files drive the in-app "What's New" view *and* `APP_VERSION` (see `src/renderer/dashboard/changelog.ts`, a build-time glob). When cutting a release, bump `package.json` `version` AND add `changelog/<version>.md` — keep them in sync.

## Conventions & workflow

- **Branch first — never commit directly to `master`/`main`.** The maintainer merges via PRs from feature branches. Check branch status before committing.
- Do **not** bump the version or write changelog entries unless explicitly asked.
- Match the surrounding code's style; the shared UI kit (`src/renderer/components/ui.tsx`) and the generic `DataTable` are meant to be reused across pages rather than re-rolled.
- `docs/` holds the design docs (PRD, architecture, IPC map, DB, OpenAI service, security). `docs/sessions/` is a running dev log (one file per day) — update it and the relevant `docs/*.md` after substantial features.
