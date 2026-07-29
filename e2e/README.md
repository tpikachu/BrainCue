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

The two `*.capture.spec.ts` files are not tests — they are the recording rig for
the demo film, the GIFs and the screenshots, all captured **from the real app**.

```bash
npm run media -- check     # is ffmpeg able to do this at all?
npm run media              # capture everything, then build everything
```

**[docs/21-MEDIA.md](../docs/21-MEDIA.md) is the guide**: the storyboard, the
style rules, what each asset is for, and the checklist before any of it ships.
What belongs here instead are the two harness facts that shape how those specs
are written:

- Capture is **opt-in** — `playwright.config.ts` ignores `*.capture.spec.ts`
  unless `E2E_CAPTURE` is set, because they need a real key and write into the
  repo. They also need a **display**; they will not run on a headless CI box.
  `npm run media` sets the variable for you, which matters because
  `E2E_CAPTURE=1 npx …` is a bash-ism that silently does nothing in `cmd.exe`.

- **Frames, not Playwright video.** The harness attaches to an already-running
  Electron over CDP (see below), and `recordVideo` is a **context-creation**
  option — it cannot be enabled on a context we merely connected to. Bursting
  screenshots works over CDP, is deterministic, and lets ffmpeg choose the frame
  rate after the fact.

### Driving the UI from a spec

Two traps, both of which have cost a whole capture run:

- **There is no `<select>` in this app.** `Select` in `components/ui.tsx` takes
  `<option>` children and has the type signature of a native select, then
  renders a `Dropdown` — `button[aria-haspopup="listbox"]` over
  `li[role="option"]`. So `selectOption()` waits out its timeout on a control
  that is plainly on screen. Use the exported `choose(scope, label, nth)` helper
  in `fixtures.ts`.

- **Bound your action timeout.** Playwright's default is *unbounded*, capped
  only by the test timeout — which a capture run sets to tens of minutes. One
  un-clickable element then eats the entire run rather than failing its own
  scene. Both capture specs call `page.setDefaultTimeout(...)` and close any
  modal a failed scene left open, because a modal swallows every click behind
  it.

Navigation uses the sidebar's `data-tour="nav-*"` anchors rather than visible
link text. Those anchors are load-bearing for the onboarding tour, so they
don't drift silently — whereas the previous version of the screenshot spec
still clicked "Interview" / "Mock" / "Reports" nav items that the mode-first
redesign had already removed, which is how the assets went stale.

Frames land in `docs/media/frames/` (gitignored scratch); only the built
`.gif`/`.mp4` and the stills in `docs/images/` are committed.

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
