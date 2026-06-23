import { BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { EVENTS } from '@shared/ipc';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { captureScreen } from '../services/capture/screenshot';
import { applyPrivacyToWindow } from '../services/session/privacy';
import { log } from '../services/security/logger';
import { broadcast } from '../ipc/broadcast';
import { getMainWindow } from './mainWindow';
import { getOverlayWindow } from './overlayWindow';

let selectionWin: BrowserWindow | null = null;
let pendingFrame: string | null = null;
let toRestore: BrowserWindow[] = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reject if a promise doesn't settle in time, so a stalled screen-capture API
 *  can't leave the app frozen with its windows hidden and no error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    delay(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]) as Promise<T>;
}

/** The screenshot captured just before the selector opened. */
export function getPendingFrame(): string | null {
  return pendingFrame;
}

/**
 * Capture the primary screen and open a full-screen overlay for the user to
 * drag-select a region. App windows are hidden before the capture so they are
 * never in the frame (and don't appear as black under content protection); they
 * are restored when the selector closes.
 */
export async function openSelector(): Promise<void> {
  if (selectionWin && !selectionWin.isDestroyed()) {
    selectionWin.focus();
    return;
  }

  // Hide our own windows so we capture what's behind them (the actual content).
  toRestore = [];
  for (const w of [getMainWindow(), getOverlayWindow()]) {
    if (w && !w.isDestroyed() && w.isVisible()) {
      toRestore.push(w);
      w.hide();
    }
  }
  await delay(220); // let the OS repaint before grabbing the screen

  // Everything past here can throw (capture/permission/window creation). If it
  // does after we've hidden the app windows, restore them — otherwise the app
  // looks like it vanished (windows hidden, no selector, no error). Surface the
  // real cause to the log and the dashboard.
  try {
    // Select on whichever display the cursor is on (where the user is working),
    // not always the primary one — otherwise on multi-monitor setups the app
    // windows hide everywhere but the selector only appears on the primary screen.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { dataUrl } = await withTimeout(captureScreen(display), 8000, 'screen capture');
    pendingFrame = dataUrl;

    const { x, y, width, height } = display.bounds;

    selectionWin = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      // Opaque (NOT transparent): the renderer paints the frozen screenshot as
      // the full-screen background and the user selects over that. Transparent
      // windows are unreliable on Windows — combined with content protection
      // (Privacy Mode) they can fail to composite, leaving the selector
      // invisible so the app looks like it "disappeared" (main/overlay hidden,
      // selector see-through). A solid window always paints. WYSIWYG cropping is
      // also more accurate against the frozen frame than the live desktop.
      transparent: false,
      backgroundColor: '#000000',
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    selectionWin.setAlwaysOnTop(true, 'screen-saver');
    selectionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    selectionWin.focus();
    applyPrivacyToWindow(selectionWin);
    attachDiagnostics(selectionWin, 'selector');
    loadRenderer(selectionWin, 'selection');

    selectionWin.on('closed', () => {
      selectionWin = null;
      pendingFrame = null;
      restoreWindows();
    });
  } catch (e) {
    log.error('openSelector failed; restoring windows', e);
    pendingFrame = null;
    if (selectionWin && !selectionWin.isDestroyed()) selectionWin.destroy();
    selectionWin = null;
    restoreWindows();
    broadcast(
      EVENTS.sessionError,
      { message: `Region capture failed: ${e instanceof Error ? e.message : String(e)}` },
      ['main', 'overlay'],
    );
    throw e;
  }
}

function restoreWindows(): void {
  for (const w of toRestore) if (!w.isDestroyed()) w.show();
  toRestore = [];
}

export function closeSelector(): void {
  if (selectionWin && !selectionWin.isDestroyed()) selectionWin.close();
  else restoreWindows();
  selectionWin = null;
  pendingFrame = null;
}
