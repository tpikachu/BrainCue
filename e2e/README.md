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

For the **live tier** only, put your key in `.env` (already gitignored):

```
OPENAI_API_KEY=sk-...
```

## Run

```bash
npm run test:e2e        # OFFLINE tier: builds first, then every default spec
npm run test:e2e:only   # the same, without the build (uses the existing out/ bundle)
npx playwright test e2e/data-integrity.spec.ts   # one file (offline)
npm run test:e2e:live   # LIVE tier: real provider calls — on purpose only (costs money)
```

Three tiers, kept apart:

- **Offline — the default (`playwright.config.ts`).** Needs no key, no network, no
  microphone and no screen, and is built so it cannot use them. For every real-app test
  `fixtures.ts` strips every `*_API_KEY` from the environment (the only place the app reads
  a key outside its own database), gives the app a fresh data dir, and loads
  **`offline-guard.cjs`** into the app's main process (`NODE_OPTIONS=--require`):
  - every outbound connection is refused unless it is to loopback (`127.0.0.1`, `::1`, or
    `::ffff:127.0.0.1` in any spelling). The check sits on every TCP socket main opens
    (`net.Socket#connect`), so fetch, http/https, ws, SDK clients and **every redirect hop**
    go through it; `fetch`/`http`/`https` and Electron `net` also refuse early, and page
    requests are refused through `webRequest`;
  - capture is refused — the app's own permission and display-media handlers (which grant
    capture, and hand Chromium the call-audio loopback with no picker) are replaced by ones
    that refuse it; native screenshots (`desktopCapturer.getSources` — the region solver and
    the loopback fallback) are refused before the real API runs; pages get a
    `getUserMedia`/`getDisplayMedia` that reject; Chromium's fake capture device is on as a
    last line;
  - windows open on a secondary display when one exists (`E2E_KEEP_PRIMARY=1` to opt out).

  Every attempt is logged (`offline-guard.jsonl` in the test's output dir, attached to the
  report), and the fixture **fails any test in which something was granted**.
  `offline-guard.spec.ts` proves the guard itself: no key of any kind, the microphone and
  call audio refused, a provider call from main and a request from the page refused, the
  app's real region capture refused — and, in plain Node with loopback servers and a fake
  Electron (`guard-probes/`), that a forbidden host (127.0.0.2) cannot be reached directly,
  through an IPv4-mapped IPv6 address, through a redirect from an allowed server or by a raw
  socket, while loopback stays reachable; and that a screenshot never reaches the capture
  transport. `E2E_GUARD_UNDER_TEST` runs those probes against another guard file.
  The renderer-harness specs need none of this — they run real components against a fake
  bridge, with no app main, DB, provider or device.
- **Live (`playwright.live.config.ts`, `npm run test:e2e:live`).** `live-*.spec.ts` only,
  with the key from `.env`: real résumé parse + embeddings + retrieval, asserting on
  *structure*, not exact text. It sends sample data to the provider. Skipped without a key.
- **Capture (`E2E_CAPTURE=1`).** The `*.capture.spec.ts` recording rig (below) — opt-in;
  the media and screenshot specs run in the fixture's live mode.

## What's covered / not

- ✅ Offline guard (`offline-guard.spec.ts`) — see above.
- ✅ Smoke (`smoke.spec.ts`): a fresh install opens first-run setup; with a profile, the
  sidebar sections; Home's Start interview opens the start flow, whose rows say what is
  missing (no key, no résumé) with Start disabled and the disclosure shown, and nothing
  starts; Interviews (New role, the blocker line); Library tabs; Sessions (empty) and
  Insights; Settings landing on Preferences, and no provider configured.
- ✅ A failed answer with no key surfaces an error and clears the streaming state
  (`error-handling.spec.ts`).
- ✅ Start flow role choice (`start-flow.spec.ts`, no key, nothing captured): a role beyond
  the picker's first page stays chosen when handed in or remembered, is reachable by search,
  and a deleted or other-profile role is never the default.
- ✅ Renderer harness (`harness/harness.ts` + `harness/entry.tsx`): REAL components,
  bundled with esbuild, in the project's Electron with one HIDDEN window (`harness/main.cjs`
  — no app code, DB, audio or network). The preload bridge is a fake that records every
  call and whose replies a test can script, hold or fail; startNew / resumeExisting record
  what they were asked to start. Each load proves the page takes input (a hidden window
  occasionally hands a fresh document none) and reloads if not. Nothing in it can capture:
  harness main refuses every permission request (Electron grants them by default), Chromium's
  fake devices are on, and the page gets a `mediaDevices` whose calls are recorded
  (`__fake.media`) and rejected. The harness origin is not a secure context, so before this
  a component's mic probe failed with a TypeError instead. `HARNESS_ROOT` bundles
  from another checkout (an earlier commit's worktree) for before/after runs. Screenshots
  are opt-in: `HARNESS_CAPTURE_PORT` serves Electron's own capture of the window on
  127.0.0.1 (CDP captures wait for frames a hidden window does not always paint), and
  `HARNESS_SHOW_X` (≥ 1920 only) shows it without focus on a second monitor.
  - `startModal.race.spec.ts` — the start flow under controlled timing (late lookups after
    reopen, a newer pick, a profile switch, a stale failure) and Resume through it — which
    re-reads the session and its role when pressed (deleted, detached, unreadable, moved).
  - `history-and-save.spec.ts` — history opens from the persisted session only (no report,
    no model call), including a saved voice quick Ask; reports are explicit; Keep reports
    each outcome (success, failure + Retry, no Space, a refused destination), never files out
    of an unreadable Space, shows a Retry's own errors and a gone destination on the result
    view, re-runs only the failed half, stays open while busy, Discard asks first.
  - `cue-card.spec.ts` — the current question dominates; missed questions stay with why and
    a retry; earlier cards behind a toggle; sources name the provider; an unconfirmed Stop
    after a failed rollback is said in the Cue Card.
  - `useful-paint.spec.ts` (M7.2b, PERF-01) — the Cue Card reports the first USEFUL paint
    only once the painted text holds a real word. A bare `**` or a bullet marker split
    across tokens is not reported; one report per card, and again after a regenerate.
    With the page's animation frames held: a report still pending from before a reset never
    satisfies the replacement take (a real recorder gets nothing), while the replacement's
    own words are reported with its take and accepted.
  - `keyboard-drafts.spec.ts` — focus contained and restored, dropdown keys and ARIA state,
    Escape closes the inner control first, edited drafts and busy saves survive dismissal,
    readiness detail reachable by keyboard.
  - `popovers.spec.ts` (UI-01/UI-02) — tooltips and the compact model list stay inside a
    467 × 462 Cue Card (and after resize); dropdowns close on an outside press inside a
    dialog, More on an outside press, Escape and blur (inner list first); Settings replaces
    More; click-through waits until open controls have had their outside press.
  - `model-labels.spec.ts` (AI-01) — each chip names its task (Interview answers / Coding
    solver) and the model main resolved, not the coding override or the OpenAI table; a
    solver pick does not re-answer, an answer pick does; a pushed route change relabels the
    chip while existing answers keep "Answered by …" and their sources' provider; Cue Card
    settings uses the shared picker (Automatic names the real pick) and its mic probe is
    refused.
  - `settings-order.spec.ts` (AI-01 correction): replies released out of order with
    `{ defer: id }` + `__fake.settle`.
    - A read held past a newer push does not restore the old chip model.
    - Of two answer picks in flight, the later one stays.
    - Cue Card settings: a read held across close/reopen does not restore the old solver.
    - An effort-only edit writes only `effortOverrides`.
    - A late model-save reply does not revert a later effort.
  - `catalog-bounds.spec.ts` (UI-03): the full OpenAI + Anthropic catalog stays inside
    467 × 462 and 360 × 462 Cue Cards, with no horizontal scroll.
    - End and the pointer reach rows deep in the list.
    - The list is placed again on resize while open.
    - Positive controls: a 1100 px window keeps the 22rem cap; a control wider than the
      cap gets a list at least as wide as itself.
  - `models-draft.spec.ts` (AI-02): Settings → Language Models on the real settings store
    (harness view `modelsPanel`, with the shell's push → store subscription).
    - An unrelated push keeps the unsaved answer choice and Advanced stays open; Save
      writes exactly `{ modelOverrides: { answer } }`.
    - Another task changed elsewhere refreshes, and Save doesn't rewrite it.
    - A newer edit outlives an older save's completion.
    - An empty Save writes nothing.
- ✅ History in the real app (`history.spec.ts`, no key): a sample conversation opens from
  the DB with no report; `session:remember` reports a failed summary as failed and keeps
  the transcript; a missing or other-profile Space is refused in main.
- ✅ Real main + SQLite via `window.api` (`data-integrity.spec.ts`): interview delete
  **FK cascade** and profile-delete cascade — each also proves no provider was even tried —
  and the model preset + per-task override round-trip (model ids are policy data, so it
  checks the round-trip, not a hard-coded id).
- ✅ (live) résumé parse → embed → RAG retrieval.
- ❌ **Live transcription / mic / call audio / global shortcuts, and live answers** — the
  offline tier refuses them by design; they need controlled audio, real providers and a
  display (M7.2). Their pure logic is unit-tested.

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
  repo. The media and screenshot specs set `test.use({ live: true })`, so they
  run with the key and network the offline guard would refuse. They also need a **display**; they will not run on a headless CI box.
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
- A fresh data dir has no profile, so the app opens first-run setup. A test that needs the
  dashboard creates a profile and sets `onboardingDone` (see `withProfile` in
  `smoke.spec.ts`); `fixtures.ts` only marks the tour and data notice as seen.
- Data-integrity specs use `window.api` directly rather than clicking through forms —
  robust, and they target the exact main/DB paths.
- Privacy Mode (content protection) excludes windows from *screen capture*, not from
  Playwright's CDP connection, so it doesn't interfere here.
