# End-to-end tests (Playwright + Electron)

These drive the **built** Electron app — real main process, real SQLite, real IPC —
to cover what the vitest unit suite structurally can't (the DB layer is built for
Electron's ABI and won't load under node).

## Setup

```bash
npm install            # pulls @playwright/test + dotenv (added to devDependencies)
```

> No `npx playwright install` needed — these tests don't use Playwright's bundled
> browsers. They launch the project's own Electron and connect over CDP (see below).

For the **live tier**, put your key in `.env` (already gitignored):

```
OPENAI_API_KEY=sk-...
```

## Run

```bash
npm run test:e2e        # builds first, then runs all specs
npm run test:e2e:only   # skip the build (use the existing out/ bundle)
npx playwright test e2e/data-integrity.spec.ts   # one file
```

Two tiers:
- **Default (no key):** UI smoke + data-integrity (FK cascade, settings round-trip) via
  the real DB. Runs in CI.
- **Live (`OPENAI_API_KEY` set):** `live-openai.spec.ts` hits real OpenAI (résumé parse
  + embeddings + RAG). It asserts on *structure*, not exact text. Skipped without a key.

## What's covered / not

- ✅ App launches; dashboard renders; navigation.
- ✅ Real main + SQLite via `window.api`: interview delete **FK cascade**, profile-delete
  cascade, model preset + per-task override round-trip.
- ✅ (live) résumé parse → embed → RAG retrieval.
- ❌ **Live transcription / mic / screen capture / global shortcuts** — need real
  hardware + a display; not automatable headlessly. Their pure logic is unit-tested;
  the answer pipeline is exercised here via the no-audio sample/RAG path.

## Capturing marketing media

The root README and the landing page (`docs/index.html`) share one set of
assets: animated clips in `docs/media/`, stills in `docs/images/`. Both are
regenerated **from the real app** — nothing is mocked up in a design tool.

Capture is opt-in: `playwright.config.ts` ignores `*.capture.spec.ts` unless
`E2E_CAPTURE` is set, because these specs need a real key and write into the
repo. They also need a **display** (the app is driven visibly) — they will not
run on a headless CI box.

### Stills

```bash
E2E_CAPTURE=1 npx playwright test e2e/screenshots.capture.spec.ts   # bash / Git Bash
```
```powershell
$env:E2E_CAPTURE=1; npx playwright test e2e/screenshots.capture.spec.ts
```

Writes `docs/images/`: `home.png`, `library.png`, `sessions.png`,
`insights.png`, `settings.png`, `start-flow.png`, `cue-card.png`.

### Animated clips (GIF + MP4)

Two steps — burst frames from the running app, then assemble them:

```bash
E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts
node scripts/build-media.mjs cue-card-stream --fps 12 --width 760
```

The spec writes numbered PNGs to `docs/media/frames/<clip>/` (scratch —
gitignored); the script turns them into `docs/media/<clip>.gif` and
`<clip>.mp4`. Only the built `.gif`/`.mp4` are committed.

`build-media.mjs` needs **ffmpeg** on PATH (`winget install Gyan.FFmpeg` ·
`brew install ffmpeg` · `apt install ffmpeg`). It builds the GIF with a two-pass
global palette, which keeps flat UI colour and thin text sharp where ffmpeg's
default quantisation smears them.

### Why frames, not Playwright video

The harness attaches to an already-running Electron over CDP (see below), and
`recordVideo` is a **context-creation** option — it can't be enabled on a
context we merely connected to. Bursting screenshots works over CDP, is
deterministic, and lets ffmpeg choose the frame rate after the fact.

### Keeping captures from rotting

Navigation uses the sidebar's `data-tour="nav-*"` anchors rather than visible
link text. Those anchors are load-bearing for the onboarding tour, so they
don't drift silently — whereas the previous version of the screenshot spec
still clicked "Interview" / "Mock" / "Reports" nav items that the mode-first
redesign had already removed, which is how the assets went stale.

## How the harness works (and why)

Playwright's built-in `_electron.launch()` is **broken on Electron 30+** — it passes
`--remote-debugging-port=0` as a CLI flag that Electron rejects
([microsoft/playwright#39008](https://github.com/microsoft/playwright/issues/39008)).
So `e2e/fixtures.ts` instead:

1. spawns the built app (`out/main/index.js`) directly with `BRAINCUE_E2E=1`;
2. the app opens a fixed CDP port via `appendSwitch` (`src/main/index.ts`, gated on
   the E2E flag) — which Electron *does* honor;
3. the fixture connects with `chromium.connectOverCDP` and grabs the dashboard window.

`e2e/global-setup.ts` copies `drizzle/` → `out/main/drizzle` so the built app finds its
migrations (electron-builder does this when packaging; a bare `out/` run doesn't).

## Notes / gotchas

- Tests launch `out/main/index.js`, so a **build must exist** (`test:e2e` builds for you).
- Each test runs against an **isolated data dir** (`E2E_USER_DATA`, honored by
  `src/main/index.ts`) so your real profiles/sessions are never touched.
- Data-integrity specs use `window.api` directly rather than clicking through forms —
  robust, and they target the exact main/DB paths.
- Privacy Mode (content protection) excludes windows from *screen capture*, not from
  Playwright's CDP connection, so it doesn't interfere here.
