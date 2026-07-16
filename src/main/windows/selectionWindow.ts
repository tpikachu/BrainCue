import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { EVENTS } from '@shared/ipc';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { captureScreen } from '../services/capture/screenshot';
import { applyPrivacyToWindow, protectWindow } from '../services/session/privacy';
import { log } from '../services/security/logger';
import { broadcast } from '../ipc/broadcast';
import { getMainWindow } from './mainWindow';
import { getOverlayWindow } from './overlayWindow';

let selectionWin: BrowserWindow | null = null;
let pendingFrame: string | null = null;
let toRestore: BrowserWindow[] = [];
let isOpen = false;

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
 * Create the region-selector window ONCE at startup (hidden) and keep it alive,
 * exactly like the overlay. Creating it on demand — right after a GPU-heavy
 * screen capture — made its renderer fail to load from the dev server, leaving an
 * on-top blank black window. Pre-loading it here means a capture only has to push
 * the new frame and show the window, with no fragile load to race.
 */
export function createSelectionWindow(): BrowserWindow {
  if (selectionWin && !selectionWin.isDestroyed()) return selectionWin;

  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  selectionWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    show: false,
    // Opaque (NOT transparent): the renderer paints the frozen screenshot as the
    // full-screen background and the user selects over that. Transparent windows
    // are unreliable on Windows (esp. with content protection) — a solid window
    // always paints, and WYSIWYG cropping is more accurate against the frozen frame.
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

  selectionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Exclude the (fullscreen) selector from capture at creation and on show;
  // OS-side wipes are detected and healed by the protection observer
  // (matches the other windows).
  protectWindow(selectionWin);
  attachDiagnostics(selectionWin, 'selector');

  // SAFETY NET: cancel from the main process on Escape, even if the renderer's own
  // key handler never ran. Without this, a stuck selector is an always-on-top
  // full-screen window the user can't escape.
  selectionWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') closeSelector();
  });

  selectionWin.on('closed', () => {
    selectionWin = null;
    if (isOpen) restoreWindows();
    isOpen = false;
    pendingFrame = null;
  });

  loadRenderer(selectionWin, 'selection');
  log.info('selection window created (hidden, pre-loaded)');
  return selectionWin;
}

/**
 * Capture the screen and show the pre-created selector for the user to drag-select
 * a region. App windows are hidden before the capture so they're never in the
 * frame; they're restored when the selector closes.
 */
export async function openSelector(): Promise<void> {
  const win = createSelectionWindow(); // ensure it exists (and is loaded)
  if (isOpen && win.isVisible()) {
    win.focus();
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
  log.info(`openSelector: hid ${toRestore.length} app window(s) before capture`);
  await delay(220); // let the OS repaint before grabbing the screen

  try {
    // Select on whichever display the cursor is on (where the user is working).
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { dataUrl } = await withTimeout(captureScreen(display), 8000, 'screen capture');
    pendingFrame = dataUrl;
    isOpen = true;

    // Cover the active display, hand the renderer the fresh frame + reset its
    // selection state, then reveal once it has had a moment to paint.
    win.setBounds(display.bounds);
    win.webContents.send(EVENTS.selectionReset, { image: dataUrl });
    await delay(120); // let the renderer paint the frame before the window appears

    // Exclude from screen capture BEFORE it appears, so it never shows on a screen
    // share (the `show` handler re-applies, but set it up front to avoid any gap).
    applyPrivacyToWindow(win);
    win.show();
    // Force foreground: triggered from a global shortcut the app isn't foreground,
    // so a plain show() could leave the selector behind the user's active window.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    app.focus({ steal: true });
    win.focus();
    log.info(
      `selector shown: visible=${win.isVisible()} focused=${win.isFocused()} onTop=${win.isAlwaysOnTop()}`,
    );
  } catch (e) {
    log.error('openSelector failed; restoring windows', e);
    pendingFrame = null;
    isOpen = false;
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

/** Hide the selector (kept alive for next time) and restore the app windows. */
export function closeSelector(): void {
  isOpen = false;
  pendingFrame = null;
  if (selectionWin && !selectionWin.isDestroyed()) selectionWin.hide();
  restoreWindows();
}
