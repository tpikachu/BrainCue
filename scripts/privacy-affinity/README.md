# Privacy affinity harness

Ground-truth verification that Privacy Mode really keeps every window excluded
from screen capture — measured at the OS level, not inferred from Electron
state.

```bash
npm run build && node scripts/privacy-affinity/drive.js
```

What it does:

- **drive.js** launches the BUILT app (isolated userData under `.out/`, CDP on,
  `OPENAI_API_KEY` from the repo `.env`), disables the onboarding tour
  (`settings.set({ tourDone: true })` — it blocks interaction and fakes
  results), loads sample data, click-explores every dashboard page, selects the
  sample profile via the in-window dropdown, **starts a real live interview**
  (loopback capture — the known protection-wipe trigger), clicks the Cue Card,
  stops the session, then prints a per-window affinity report and a
  PASS/FAIL verdict.
- **probe.js** (spawned by drive.js) is the oracle: a **separate process** that
  samples `GetWindowDisplayAffinity` (koffi → user32) for every top-level
  window of the app PID every ~15ms. Only a separate process is trustworthy
  here — the app's own `desktopCapturer` cannot see its own protected windows,
  and Electron has no getter for content protection.

## Hard test (`hardtest.js`) — exhaustive edge-action sweep

```bash
npm run build && node scripts/privacy-affinity/hardtest.js
```

A stricter superset of `drive.js`. Same separate-process affinity probe, but the
driver hammers **every** edge action that could wipe a window's capture
exclusion and asserts the dashboard + Cue Card stay `0x11` the whole time:

- nav / dropdown / hover storms, dashboard minimize / maximize / restore, overlay
  hide / show, privacy re-assert;
- a real live interview (loopback capture — the known wipe trigger) + the full
  Cue Card control storm (expand/compact, opacity, click-through, type/format
  sweeps, pronunciation, Ask box);
- an **OS-level move storm** (koffi `SetWindowPos`, ~130–160 moves) — the
  "hold-and-drag the Cue Card" test, driven at the OS level so it doesn't depend
  on synthetic-input hit-testing;
- the region selector (hides + reshows both windows), pause / resume / stop;
- a **confirm-leak check**: triggers each confirm gate (turn off Privacy Mode,
  Reset settings, Delete all data) and asserts each renders as an **in-window
  modal** (in the DOM of a protected window) rather than a native OS dialog —
  then cancels it (privacy stays on, nothing is wiped).

Verdict is per-window and strict: any sustained (> 1 share-frame) capturable
sample on the dashboard or Cue Card, or any confirm that is NOT in-window, fails.
Windows carry empty OS titles, so it labels them by size (Cue Card 440×460 /
520×680; dashboard large; loopback anchor is titled). Output lands under the
gitignored `.out/hard/`.

Reading the report: `0x11` = `WDA_EXCLUDEFROMCAPTURE` (hidden from shares),
`0x0` = capturable. `[transient]` dips (≤150ms, healed by the in-app protection
observer) are the OS wiping the affinity and the app re-protecting — expected
on Windows builds with the wipe bug, and far below a Meet/Zoom share frame at
5–15fps. `[LEAK]` means a window stayed capturable — a real failure.

Known machine behaviors this harness measured (Win 11 26200):

- While an **external screen share** (e.g. Google Meet in Chrome) is running,
  the OS wipes the affinity on ALL of the app's windows every ~5.4s. The
  observer heals each wipe within one ~50ms tick.
- `desktopCapturer.getSources` does **not** enumerate the calling process's own
  windows, so the loopback anchor must be handed to `getDisplayMedia` by
  constructed source id (`getMediaSourceId()`), never found by matching.

Notes: kill stray `electron.exe` before running (the single-instance lock makes
new launches quit silently); `.out/` contains logs and an isolated userData dir
and is gitignored — delete after inspection.
