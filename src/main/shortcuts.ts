import { globalShortcut } from 'electron';
import {
  SHORTCUT_DEFAULTS,
  type ShortcutAction,
} from '@shared/shortcuts';
import { SETTINGS_KEYS, settingsRepo } from './db/repositories/settings.repo';
import { createOverlayWindow, getOverlayWindow } from './windows/overlayWindow';
import { togglePrivacy } from './services/session/privacy';
import { sessionManager } from './services/session/sessionManager';
import { openSelector } from './windows/selectionWindow';
import { quickSolveFromClipboard } from './services/capture/codingMode';
import { log } from './services/security/logger';

let clickthrough = false;

/** Effective accelerators: user overrides (persisted) merged over the defaults,
 *  ignoring any stored key that is no longer a known action. */
export function getShortcuts(): Record<ShortcutAction, string> {
  const stored = settingsRepo.getJson<Partial<Record<ShortcutAction, string>>>(
    SETTINGS_KEYS.shortcuts,
    {},
  );
  const result = { ...SHORTCUT_DEFAULTS };
  for (const id of Object.keys(SHORTCUT_DEFAULTS) as ShortcutAction[]) {
    const v = stored[id];
    if (v && v.trim()) result[id] = v.trim();
  }
  return result;
}

function handle(action: ShortcutAction): void {
  switch (action) {
    case 'overlay:toggle': {
      const w = createOverlayWindow();
      w.isVisible() ? w.hide() : w.show();
      break;
    }
    case 'overlay:toggle-clickthrough': {
      clickthrough = !clickthrough;
      getOverlayWindow()?.setIgnoreMouseEvents(clickthrough, { forward: true });
      break;
    }
    case 'privacy:toggle':
      togglePrivacy();
      break;
    case 'session:toggle-pause':
      sessionManager.togglePauseActive();
      break;
    case 'capture:quick':
      void quickSolveFromClipboard();
      break;
    case 'capture:region':
      void openSelector();
      break;
  }
}

export function registerGlobalShortcuts(): void {
  const shortcuts = getShortcuts();
  for (const id of Object.keys(shortcuts) as ShortcutAction[]) {
    const accel = shortcuts[id];
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => handle(id));
      if (!ok) log.warn(`shortcut: failed to register ${accel} for ${id}`);
    } catch (e) {
      log.warn(`shortcut: invalid accelerator "${accel}" for ${id}`, e);
    }
  }
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}

/** Persist new accelerators (merged over current) and re-register them live, so
 *  changes from the Settings UI take effect without a restart. Returns the
 *  effective map. */
export function setShortcuts(patch: Partial<Record<ShortcutAction, string>>): Record<
  ShortcutAction,
  string
> {
  const current = getShortcuts();
  const next: Record<ShortcutAction, string> = { ...current };
  for (const id of Object.keys(SHORTCUT_DEFAULTS) as ShortcutAction[]) {
    const v = patch[id];
    if (v && v.trim()) next[id] = v.trim();
  }
  settingsRepo.setJson(SETTINGS_KEYS.shortcuts, next);
  unregisterGlobalShortcuts();
  registerGlobalShortcuts();
  return next;
}

/** Reset all shortcuts to their defaults and re-register. */
export function resetShortcuts(): Record<ShortcutAction, string> {
  settingsRepo.setJson(SETTINGS_KEYS.shortcuts, {});
  unregisterGlobalShortcuts();
  registerGlobalShortcuts();
  return { ...SHORTCUT_DEFAULTS };
}
