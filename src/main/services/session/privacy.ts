import { BrowserWindow } from 'electron';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { broadcast } from '../../ipc/broadcast';
import { EVENTS } from '@shared/ipc';
import { appEvents, APP_EVENT } from '../../appEvents';

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
