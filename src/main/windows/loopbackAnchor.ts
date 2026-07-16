import { BrowserWindow, screen } from 'electron';

// A stable, unique window title we match on in the getDisplayMedia handler.
export const LOOPBACK_ANCHOR_TITLE = 'BrainCueLoopbackAnchor';

let anchor: BrowserWindow | null = null;

/**
 * A tiny, parked-off-screen window used ONLY as the *video* source for
 * system-audio (loopback) capture during a live interview.
 *
 * Why this exists: to transcribe the interviewer we need system (loopback)
 * audio, and on Windows the only way to get it in the renderer is
 * `getDisplayMedia({ video, audio:'loopback' })` — which requires a video
 * source. If that video source is the **screen**, Chromium disables
 * `WDA_EXCLUDEFROMCAPTURE` on *this process's own windows* for as long as the
 * screen capture is live (so the user can see their own windows in their own
 * share) — which makes the Cue Card + dashboard visible in Zoom/Meet for the
 * whole interview. Capturing a **window** instead clears the exclusion only
 * once at capture-start (a single re-assert restores it durably) rather than
 * continuously. See the getDisplayMedia handler in `index.ts`.
 *
 * The anchor is content-protected (never in a share) and parked far above the
 * primary display, so it is never visible to the user; its captured video is
 * thrown away by the renderer (only the loopback audio track is kept).
 */
export function createLoopbackAnchor(): BrowserWindow {
  if (anchor && !anchor.isDestroyed()) return anchor;
  const prim = screen.getPrimaryDisplay().bounds;
  anchor = new BrowserWindow({
    // Parked well above the primary display: off every normal monitor layout,
    // but NOT at the -32000 "minimized" marker (which capture enumeration skips).
    x: prim.x + 80,
    y: prim.y - 4000,
    width: 320,
    height: 240,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Keep it out of OTHER captures too (defense in depth) — our own loopback
  // capture still sees it, because Chromium clears protection on its own
  // windows while capturing.
  anchor.setContentProtection(true);
  // A painted frame so window capture has real content; blank + off-screen.
  void anchor.loadURL('about:blank');
  const stampTitle = (): void => {
    if (anchor && !anchor.isDestroyed()) anchor.setTitle(LOOPBACK_ANCHOR_TITLE);
  };
  anchor.webContents.on('did-finish-load', stampTitle);
  // about:blank/other navigations reset the OS title — keep re-stamping it so the
  // getDisplayMedia handler can always find the source by name.
  anchor.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    stampTitle();
  });
  stampTitle();
  anchor.showInactive(); // visible (so it's enumerated as a capturable window), never focused
  anchor.on('closed', () => (anchor = null));
  return anchor;
}

export function getLoopbackAnchor(): BrowserWindow | null {
  return anchor && !anchor.isDestroyed() ? anchor : null;
}
