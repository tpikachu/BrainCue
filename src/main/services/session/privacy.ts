import { BrowserWindow } from 'electron';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { broadcast } from '../../ipc/broadcast';
import { EVENTS } from '@shared/ipc';
import { appEvents, APP_EVENT } from '../../appEvents';
import { hwndOf } from './displayAffinity';
import { AffinityObserver } from './affinityWorker';
import { confirmInWindow } from '../ui/confirm';

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
 *  also call `protectWindow` on creation so they inherit current state. */
export function applyContentProtectionToAll(enabled: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setContentProtection(enabled);
  }
}

/** Apply the current privacy setting to a single (freshly created) window. */
export function applyPrivacyToWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.setContentProtection(getPrivacy());
}

/** The single off-thread detect-and-heal observer (see affinityWorker.ts). */
const observer = new AffinityObserver();

/**
 * Apply Privacy Mode to a window once at creation and again whenever it
 * (re)shows — hide()/show() can wipe the affinity on this Electron, and a
 * hidden window is in no capture, so that write can never flash.
 *
 * Set-once + observe-and-heal is the ONLY protection. Earlier revisions also
 * re-asserted blindly on click/focus/move/z-order events and on interval
 * shields; every such re-CALL of setContentProtection composites a fresh frame
 * that an active WGC capture (Zoom/Meet) can show as a one-frame flicker — the
 * "flash" users saw. The observer (startProtectionObserver below) instead READS
 * the OS-level affinity (side-effect-free) and restores it with the raw
 * `SetWindowDisplayAffinity` only on a window the OS has actually wiped.
 */
export function protectWindow(win: BrowserWindow): void {
  applyPrivacyToWindow(win); // protect once, now, at creation
  win.on('show', () => applyPrivacyToWindow(win));
  // Register with the off-thread observer so a wipe by an external capturer (or
  // our own loopback capture) is detected and healed within a tick. Capture the
  // HWND now — it reads 0 once the window is destroyed.
  const hwnd = hwndOf(win);
  observer.watch(hwnd);
  win.on('closed', () => observer.unwatch(hwnd));
}

/** How often (and how many times) the observer caught the OS with a window's
 *  capture-exclusion wiped. Diagnostics for tests and support. */
export function getProtectionObserverStats(): { breaches: number; lastBreachAt: number } {
  return observer.getStats();
}

/**
 * The protection observer ("observe bot"): a worker thread reads the REAL
 * `GetWindowDisplayAffinity` of every protected window every ~12ms and restores
 * (raw `SetWindowDisplayAffinity`) any window the OS has wiped — the known
 * triggers being an external screen share / remote-desktop tool clearing the
 * exclusion behind our back, and our own loopback capture starting with a live
 * session. Reading is side-effect-free, so a healthy steady state makes ZERO
 * writes (no interval flicker); a real wipe is healed within one tick. It runs
 * OFF the UI thread so a busy main process (streaming an answer mid-interview)
 * can never delay healing. Call once at startup after the windows exist.
 */
export function startProtectionObserver(): void {
  observer.start(getPrivacy());
}

export function stopProtectionObserver(): void {
  observer.stop();
}

export function setPrivacy(enabled: boolean): boolean {
  settingsRepo.set(SETTINGS_KEYS.privacyMode, enabled ? '1' : '0');
  applyContentProtectionToAll(enabled);
  // Mirror the toggle to the observer so it stops healing when the user has
  // deliberately made the windows capturable (and resumes when re-enabled).
  observer.setPrivacy(enabled);
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
    if (confirming) return getPrivacy(); // a confirm is already open
    confirming = true;
    try {
      // In-window confirm (NOT a native dialog — that's a separate OS window
      // visible in a screen share, exactly when Privacy Mode is still on).
      const ok = await confirmInWindow({
        title: 'Turn off Privacy Mode?',
        detail:
          'BrainCue will become visible to screen sharing and recording — anyone you share your screen with (Zoom, Meet, Teams) could see it. Leave it on unless you are sure.',
        confirmLabel: 'Turn off Privacy Mode',
        cancelLabel: 'Keep it on',
        tone: 'danger',
      });
      if (!ok) return getPrivacy(); // cancelled — unchanged
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
