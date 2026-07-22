import { globalShortcut } from 'electron';
import {
  SHORTCUT_DEFAULTS,
  type ShortcutAction,
} from '@shared/shortcuts';
import { EVENTS } from '@shared/ipc';
import { SETTINGS_KEYS, settingsRepo } from './db/repositories/settings.repo';
import { createOverlayWindow } from './windows/overlayWindow';
import { broadcast } from './ipc/broadcast';
import { togglePrivacyGuarded } from './services/session/privacy';
import { sessionManager } from './services/session/sessionManager';
import { openSelector } from './windows/selectionWindow';
import { quickSolveFromClipboard } from './services/capture/codingMode';
import { voiceService } from './services/voice/voiceService';
import { quitApp } from './quit';
import { log } from './services/security/logger';

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
    case 'overlay:toggle-clickthrough':
      // Let the overlay renderer toggle it, so click-through stays per-region
      // (the control bar remains clickable) instead of locking the whole window.
      broadcast(EVENTS.overlayClickthrough, {}, ['overlay']);
      break;
    case 'privacy:toggle':
      void togglePrivacyGuarded();
      break;
    case 'session:toggle-pause': {
      const r = sessionManager.togglePauseActive();
      if (r.active) voiceService.syncSessionPaused(r.paused); // pause silences voice too
      break;
    }
    case 'voice:summon':
      // Push-to-talk from anywhere: one key that listens / sends / barges in.
      voiceService.summon();
      break;
    case 'capture:quick':
      void quickSolveFromClipboard();
      break;
    case 'capture:region':
      void openSelector();
      break;
    case 'app:quit':
      // Full quit -> before-quit -> performShutdown tears down the socket,
      // shortcuts, tray and all windows, so nothing is left running.
      quitApp();
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
