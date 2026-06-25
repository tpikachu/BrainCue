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
