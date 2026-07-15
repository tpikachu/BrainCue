import { BrowserWindow, dialog } from 'electron';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { broadcast } from '../../ipc/broadcast';
import { EVENTS } from '@shared/ipc';
import { appEvents, APP_EVENT } from '../../appEvents';

/** Whether setContentProtection actually works on this platform. On Linux
 *  (X11/Wayland) it is a silent no-op — the app IS visible in screen shares no
 *  matter what the toggle says, so the UI must say so instead of promising
 *  invisibility it can't deliver. Windows (WDA_EXCLUDEFROMCAPTURE) and macOS
 *  (NSWindowSharingNone) both honor it. */
export const privacySupported = process.platform !== 'linux';

/** Privacy Mode excludes ALL app windows (dashboard, overlay, region selector,
 *  any future modal/window) from OS screen capture, so nothing appears when the
 *  user shares their screen in Zoom/Meet/Teams or records. Defaults to ON: an
 *  unset value is treated as enabled; only an explicit '0' disables it. */
export function getPrivacy(): boolean {
  return settingsRepo.get(SETTINGS_KEYS.privacyMode) !== '0';
}

/** Apply the given protection state to every open window. New windows should
 *  also call `applyPrivacyToWindow` on creation so they inherit current state. */
export function applyContentProtectionToAll(enabled: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setContentProtection(enabled);
  }
}

/** Apply the current privacy setting to a single (freshly created) window. */
export function applyPrivacyToWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.setContentProtection(getPrivacy());
}

/**
 * Apply Privacy Mode to a window AND keep it applied across the operations that
 * silently drop it on Windows.
 *
 * What ground-truth capture testing (separate-process WGC/DXGI oracle + real
 * SendInput clicks, 2026-07-15) established about WDA_EXCLUDEFROMCAPTURE here:
 *  - GetWindowDisplayAffinity NEVER changes during a leak (stays 0x11 across
 *    ~1M samples while the window is plainly visible in capture): the drop is
 *    internal to DWM's composition, so it can't be detected by polling — only
 *    healed by re-CALLING SetWindowDisplayAffinity.
 *  - Re-calling setContentProtection is invisible in capture (0 leak frames
 *    across hundreds of re-calls at 55 fps), so re-asserting often is free.
 *  - The drop triggers observed: window ACTIVATION (click on an inactive
 *    window), a plain CLICK on an ALREADY-ACTIVE window (~1 in 5, and no
 *    activation message fires for it), and Z-ORDER changes via SetWindowPos
 *    (no Electron event at all). The last two left the window visible
 *    INDEFINITELY before this fix, because nothing re-asserted.
 *
 * So: re-assert on every signal that accompanies those triggers, each with a
 * short deferred double-tap — the synchronous re-assert can run BEFORE the
 * DWM drop caused by the same input lands, so we re-assert again just after.
 *   - native activation messages (synchronous, earliest click signal):
 *     WM_MOUSEACTIVATE 0x0021 · WM_ACTIVATE 0x0006 · WM_NCACTIVATE 0x0086 ·
 *     WM_SETFOCUS 0x0007
 *   - WM_PARENTNOTIFY 0x0210 — button-down inside child HWNDs (click on an
 *     active window) · WM_WINDOWPOSCHANGED 0x0047 — move/size/Z-ORDER changes
 *   - webContents 'input-event' mouseDown — Chromium-level click delivery,
 *     guaranteed even if child HWND styles suppress WM_PARENTNOTIFY
 *   - Electron show/move/resize/restore/focus events (cross-platform paths;
 *     move/resize also keep a live drag covered)
 * `applyPrivacyToWindow` respects the current on/off state, so this correctly
 * clears protection too when Privacy Mode is off. Call once per window at
 * creation.
 */
export function keepContentProtected(win: BrowserWindow): void {
  const reassert = (): void => applyPrivacyToWindow(win);
  // Re-assert now AND repeatedly over the next ~300ms: the DWM drop caused by
  // the very input we're reacting to lands a moment AFTER our synchronous call,
  // so a single re-assert misses it. A dense early cascade — front-loaded at
  // ~4/10/20ms because the leak window between the drop and the first heal is
  // only a frame or two — closes it to about one 30fps frame. Timers collapse
  // (one pending cascade) so a click storm or drag can't pile them up.
  const TAPS = [4, 10, 20, 40, 80, 160, 300];
  let taps: ReturnType<typeof setTimeout>[] = [];
  const clearTaps = (): void => {
    for (const t of taps) clearTimeout(t);
    taps = [];
  };
  const reassertSoon = (): void => {
    reassert();
    clearTaps();
    taps = TAPS.map((ms) => setTimeout(reassert, ms));
  };
  reassert();
  if (process.platform === 'win32') {
    // In addition to the activation/click/pos messages above:
    //   WM_NCLBUTTONDOWN 0x00A1 + WM_ENTERSIZEMOVE 0x0231 — grabbing the drag
    //   region / entering the modal move loop. Ground-truth capture caught a
    //   single-frame flash right at drag START (after the grab, before the
    //   first WM_MOVE) — these two messages are the only signals in that gap.
    //   WM_EXITSIZEMOVE 0x0232 + WM_CAPTURECHANGED 0x0215 — drag/loop end.
    for (const msg of [0x0021, 0x0006, 0x0086, 0x0007, 0x0210, 0x0047, 0x00a1, 0x0231, 0x0232, 0x0215]) {
      // hookWindowMessage is Windows-only; guarded above.
      (win as unknown as { hookWindowMessage: (m: number, cb: () => void) => void }).hookWindowMessage(
        msg,
        reassertSoon,
      );
    }
  }
  win.webContents.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown') reassertSoon();
  });
  win.on('show', reassertSoon);
  win.on('move', reassertSoon);
  win.on('resize', reassertSoon);
  win.on('restore', reassertSoon);
  win.on('focus', reassertSoon);
  win.on('closed', clearTaps);
}


let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Fast periodic re-assert — the backstop for SPONTANEOUS exclusion drops.
 *
 * Ground-truth capture testing caught the Cue Card becoming visible ~470ms
 * AFTER a drag ended, with no input and no window message in between: on this
 * Windows 11 build, DWM sometimes drops WDA_EXCLUDEFROMCAPTURE on its own,
 * so event hooks alone can't bound how long a window stays visible. Two more
 * measured facts make a fast timer the right tool:
 *   - re-calling setContentProtection is INVISIBLE in capture (0 leak frames
 *     across 400+ re-calls at 55 fps), and WDA never hides the window locally,
 *     so a 50ms cadence has no visual cost anywhere;
 *   - the earlier 500ms watchdog wasn't CAUSING the "interval flashing" the
 *     user saw — it was HEALING spontaneous drops at a 500ms cadence, leaving
 *     each drop visible for up to half a second. At 20ms a drop survives at
 *     most ~1 frame of a 30fps Meet/Zoom stream (storm-tested: rapid-click
 *     bursts produced single blips of ~43ms under the earlier 50ms cadence).
 * The synchronous message hooks in keepContentProtected remain the first line
 * (they close the deterministic triggers with ~0 frames); this bounds the tail.
 *
 * Re-assert only on VISIBLE windows: the overlay is deliberately kept hidden
 * (show:false) when unused, and Chromium re-applies content protection as a
 * side effect that forces a composition pass — doing that to a hidden window
 * can leave a blank, un-hittable ghost surface (matches Chromium's own
 * IsVisible guard). Hidden windows are already absent from capture, so there
 * is nothing to heal there anyway.
 */
export function startContentProtectionWatchdog(intervalMs = 20): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!getPrivacy()) return; // never fight the user's explicit OFF
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.isVisible()) w.setContentProtection(true);
    }
  }, intervalMs);
  // Never keep the process alive just for the watchdog.
  (watchdog as { unref?: () => void }).unref?.();
}

export function setPrivacy(enabled: boolean): boolean {
  settingsRepo.set(SETTINGS_KEYS.privacyMode, enabled ? '1' : '0');
  applyContentProtectionToAll(enabled);
  // Notify all renderer windows so their indicators stay in sync regardless of
  // who triggered the change (global shortcut, overlay button, or Settings).
  broadcast(EVENTS.privacyChanged, { enabled });
  // ...and the tray menu (main-process, not a renderer) so its checkbox matches.
  appEvents.emit(APP_EVENT.privacyChanged, enabled);
  return enabled;
}

export function togglePrivacy(): boolean {
  return setPrivacy(!getPrivacy());
}

let confirming = false;

/** Privacy Mode is ON by default and recommended. Enabling it needs no prompt,
 *  but DISABLING it asks for confirmation first (a single shared gate for the
 *  tray, Settings, and the global shortcut). Returns the effective state — if the
 *  user cancels, privacy stays on. */
export async function requestPrivacy(enabled: boolean): Promise<boolean> {
  if (!enabled && getPrivacy()) {
    if (confirming) return getPrivacy(); // a dialog is already open
    confirming = true;
    const parent =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const opts = {
      type: 'warning' as const,
      buttons: ['Turn off Privacy Mode', 'Keep it on'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Turn off Privacy Mode?',
      message: 'Turn off Privacy Mode?',
      detail:
        'BrainCue will become visible to screen sharing and recording — anyone you share your screen with (Zoom, Meet, Teams) could see it. Leave it on unless you are sure.',
    };
    try {
      const { response } = parent
        ? await dialog.showMessageBox(parent, opts)
        : await dialog.showMessageBox(opts);
      if (response !== 0) return getPrivacy(); // cancelled — unchanged
    } finally {
      confirming = false;
    }
  }
  return setPrivacy(enabled);
}

/** Toggle, routing a disable through the confirmation gate. */
export async function togglePrivacyGuarded(): Promise<boolean> {
  return requestPrivacy(!getPrivacy());
}
