import { app, BrowserWindow, dialog } from 'electron';
import { unregisterGlobalShortcuts } from './shortcuts';
import { sessionManager } from './services/session/sessionManager';
import { stopProtectionObserver } from './services/session/privacy';
import { destroyTray } from './windows/tray';
import { log } from './services/security/logger';

let quitting = false;

/** True once a real quit is underway. Window `close` handlers use this to know
 *  whether to actually close (quit) or just hide to the tray. */
export function isQuitting(): boolean {
  return quitting;
}

/** Mark the app as quitting and release every long-lived resource we own:
 *  the live transcription websocket, global shortcuts, the tray, and all
 *  windows. Without this, hidden/tray windows and the open Realtime socket keep
 *  Electron's helper processes alive after the user exits. Idempotent. */
export function performShutdown(): void {
  quitting = true;
  stopProtectionObserver();
  try {
    sessionManager.shutdown();
  } catch (e) {
    log.warn('shutdown: sessionManager.shutdown failed', e);
  }
  try {
    unregisterGlobalShortcuts();
  } catch {
    /* ignore */
  }
  try {
    destroyTray();
  } catch {
    /* ignore */
  }
  // Destroy windows directly so their `close` handlers (minimize-to-tray) can't
  // veto the quit, leaving an invisible process behind.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.removeAllListeners('close');
      w.destroy();
    }
  }
}

/** Fully quit the app (used by the tray "Exit" and anywhere we need a real
 *  quit). Triggers `before-quit`, which runs `performShutdown`. */
export function quitApp(): void {
  if (quitting) return;
  quitting = true;
  app.quit();
}

/** Tray "Exit": ask for confirmation, then fully quit. */
export async function confirmQuit(): Promise<void> {
  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const opts = {
    type: 'question' as const,
    buttons: ['Exit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Exit BrainCue Copilot',
    message: 'Exit BrainCue Copilot?',
    detail: 'The app will fully close and stop running in the background tray.',
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  if (response === 0) quitApp();
}
