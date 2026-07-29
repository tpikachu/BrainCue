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

Writes `docs/images/`: `home.png`, `library.png`, `memory.png`,
`memory-review.png`, `sessions.png`, `insights.png`, `settings.png`,
`start-flow.png`, `cue-card.png`.

The two memory shots are the same page at two scroll positions: the top, where
the two switches explain themselves, and the review queue, where the
Approve/Reject decision is actually visible. Scrolling uses a fixed `scrollTop`
rather than `scrollIntoViewIfNeeded` — the Approve row sits low but technically
*on* screen, so "if needed" decides nothing is needed and both shots come out
identical.

### Animated clips (GIF + MP4)

Two steps — burst frames from the running app, then assemble them:

```bash
E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts   # both capture tests
node scripts/build-media.mjs cuecard-stream --fps 8 --width 760 --hold 4
node scripts/build-media.mjs interview-grounded --fps 1.2 --hold 2 --width 640 --gif-only
node scripts/build-media.mjs --manifest docs/media/frames/demo/manifest.json --out braincue-demo
```

Clip names match the committed assets, so a re-capture refreshes
`docs/media/cuecard-stream.gif`, `interview-grounded.gif`, and
`braincue-demo.mp4` in place — the README and landing page pick them up with
no reference changes.

The demo is assembled from the walkthrough's per-scene frame dirs via the
manifest the spec writes (`frames/demo/manifest.json`): each scene is scaled
and padded onto one canvas with its caption burned in (drawtext), then the
segments are concatenated. Still scenes hold a single frame for `holdSec`;
the streaming scene plays at `fps` and freezes its last frame for
`tailHoldSec` so the payoff stays readable.

### The memory scenes

Scenes `07-memory-review` and `08-memory-approved` show the continuity loop, and
they run it for real rather than staging it:

- `loadSamples()` seeds a finished, **unkept** conversation in the sample
  standup Space (`src/main/services/samples/sampleData.ts`). It is left unkept
  on purpose — keeping it is the user's decision, and watching that decision run
  is the scene.
- The spec then calls `session.remember(...)`, which archives the conversation
  into its Space and extracts memory candidates through the real pipeline, and
  screenshots the review queue *before* anything is approved.
- It approves one via `memory.review(id, 'approve')` and screenshots again. That
  pair of frames is the whole point: proposed → approved is the difference
  between a suggestion and something that will be recalled.

Memory is consent-gated **off** by default, which is correct and would leave the
scene empty, so the spec turns it on explicitly first — the same switch a user
flips on the Memory page. Both scenes are skipped (and dropped from the
manifest) if extraction returns nothing, so a model that proposes zero
candidates yields a shorter video rather than two blank frames.

The spec writes numbered PNGs to `docs/media/frames/<clip>/` (scratch —
gitignored); the script turns them into `docs/media/<clip>.gif` and
`<clip>.mp4`. Only the built `.gif`/`.mp4` are committed.

`build-media.mjs` needs **ffmpeg** on PATH (`winget install Gyan.FFmpeg` ·
`brew install ffmpeg` · `apt install ffmpeg`). It builds the GIF with a two-pass
global palette, which keeps flat UI colour and thin text sharp where ffmpeg's
default quantisation smears them.

`--hold N` collapses any run of byte-identical frames to at most N. The app
idles before the answer arrives and holds still after it finishes, so a raw
capture is bookended by long stretches of the same image — leave those in and
the clip reads as a static screenshot rather than a demo.

### Getting a clip that shows the streaming

Two things decide whether the clip has any motion in it, and both have bitten:

- **Don't `await api.mock.start()` before capturing.** It only resolves once the
  question has been asked *and* answered, so awaiting it means you start filming
  after the interesting part is over. Kick it off and sample concurrently.
- **Don't stop on "text stopped changing" alone.** There's a quiet gap between
  the question landing and the first answer token; treat that as the end and you
  get a couple of seconds of nothing. `captureStream` requires `minGrowth`
  characters to have arrived before a settle counts as finished.

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
