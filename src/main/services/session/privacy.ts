import { BrowserWindow, dialog } from 'electron';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { broadcast } from '../../ipc/broadcast';
import { EVENTS } from '@shared/ipc';
import { appEvents, APP_EVENT } from '../../appEvents';
import { affinityReadable, readWindowAffinity, WDA_EXCLUDEFROMCAPTURE } from './displayAffinity';
import { log } from '../security/logger';

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

/**
 * Apply Privacy Mode to a window once at creation and again whenever it
 * (re)shows — hide()/show() can wipe the affinity on this Electron, and a
 * hidden window is in no capture, so that write can never flash.
 *
 * That is the ONLY proactive protection. Earlier revisions also re-asserted
 * blindly on click/focus/move/z-order events and on interval shields; every
 * such re-CALL of setContentProtection composites a fresh frame that an active
 * WGC capture (Zoom/Meet) can show as a one-frame flicker — the "flash" users
 * saw. Detecting real breakage is the protection observer's job
 * (startProtectionObserver below): it READS the OS-level affinity, which is
 * side-effect-free, and re-calls setContentProtection only on a window the OS
 * has actually made capturable again.
 */
export function protectWindow(win: BrowserWindow): void {
  applyPrivacyToWindow(win); // protect once, now, at creation
  win.on('show', () => applyPrivacyToWindow(win));
}

let observerTimer: ReturnType<typeof setInterval> | null = null;
const observerStats = { breaches: 0, lastBreachAt: 0 };

/** How often (and how many times) the observer caught the OS with a window's
 *  capture-exclusion wiped. Diagnostics for tests and support. */
export function getProtectionObserverStats(): { breaches: number; lastBreachAt: number } {
  return { ...observerStats };
}

function observeTick(): void {
  if (!getPrivacy()) return; // Privacy Mode off — windows are MEANT to be capturable
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const affinity = readWindowAffinity(w);
    if (affinity === null || affinity === WDA_EXCLUDEFROMCAPTURE) continue;
    // Breach: the OS wiped the exclusion, so this window is visible to screen
    // capture RIGHT NOW — the one situation where re-calling
    // setContentProtection cannot make anything worse.
    observerStats.breaches++;
    observerStats.lastBreachAt = Date.now();
    w.setContentProtection(true);
    const after = readWindowAffinity(w);
    log.warn(
      `[privacy] capture protection was wiped on "${w.getTitle()}" ` +
        `(affinity 0x${affinity.toString(16)}) — re-protected ` +
        `(now 0x${(after ?? 0xffff).toString(16)}; breach #${observerStats.breaches})`,
    );
  }
}

/**
 * The protection observer ("observe bot"): every ~50ms, read the REAL
 * `GetWindowDisplayAffinity` of every window and re-protect only a window the
 * OS has actually wiped (known trigger: our own loopback capture starting with
 * a live session; see loopbackAnchor.ts). Reading is a plain user32 query with
 * zero visual side effects, so a healthy steady state produces ZERO
 * setContentProtection calls — no interval flicker — while a real wipe (the
 * window becoming visible in the share) is healed within one tick and logged.
 * Runs for the app's whole life; each tick is a handful of native reads.
 */
export function startProtectionObserver(): void {
  stopProtectionObserver();
  if (process.platform !== 'win32') return; // the wipe + the oracle are Windows-only
  if (!affinityReadable()) {
    log.warn(
      '[privacy] protection observer unavailable (no affinity oracle) — ' +
        'a wiped capture-exclusion cannot be detected or healed on this machine',
    );
    return;
  }
  const intervalMs = Number(process.env.BRAINCUE_OBSERVER_MS) || 50;
  observerTimer = setInterval(observeTick, intervalMs);
  observerTimer.unref?.();
  log.info(`[privacy] protection observer active (affinity check every ${intervalMs}ms)`);
}

export function stopProtectionObserver(): void {
  if (observerTimer) {
    clearInterval(observerTimer);
    observerTimer = null;
  }
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
