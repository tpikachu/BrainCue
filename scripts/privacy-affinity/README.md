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
