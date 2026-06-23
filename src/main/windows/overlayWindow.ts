import { BrowserWindow } from 'electron';
import { join } from 'path';
import { EVENTS } from '@shared/ipc';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { applyPrivacyToWindow } from '../services/session/privacy';
import { getMainWindow } from './mainWindow';
import type { OverlayMode } from '@shared/types';

let overlay: BrowserWindow | null = null;

/** Tell the dashboard whether the overlay is currently visible, so its
 *  "Show/Hide overlay" button reflects toggles from the hotkey, tray, the
 *  overlay's own close button, or a session ending. */
function notifyVisibility(visible: boolean): void {
  getMainWindow()?.webContents.send(EVENTS.overlayVisibility, { visible });
}

const SIZES: Record<OverlayMode, { width: number; height: number }> = {
  compact: { width: 420, height: 200 },
  expanded: { width: 480, height: 520 },
};

/** Created once at startup (and idempotent thereafter); kept hidden when not in
 *  use so its renderer is always loaded and ready to receive streamed answers. */
export function createOverlayWindow(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;

  overlay = new BrowserWindow({
    ...SIZES.compact,
    show: false,
    frame: false,
    // Opaque (not transparent): on Windows, setContentProtection /
    // WDA_EXCLUDEFROMCAPTURE is unreliable on transparent windows — they can
    // still be picked up by screen capture. A solid window is reliably hidden.
    transparent: false,
    backgroundColor: '#0a0a0a',
    resizable: true,
    skipTaskbar: true,
    // Focusable so the user can click buttons, drag, and use the sliders.
    focusable: true,
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Respect Privacy Mode immediately (excluded from screen capture; default on).
  // Re-apply on show — display affinity is most reliable once realized.
  applyPrivacyToWindow(overlay);
  overlay.on('show', () => {
    if (overlay) applyPrivacyToWindow(overlay);
    notifyVisibility(true);
  });
  overlay.on('hide', () => notifyVisibility(false));

  attachDiagnostics(overlay, 'overlay');
  loadRenderer(overlay, 'overlay');

  overlay.on('closed', () => (overlay = null));
  return overlay;
}

/** Whether the floating overlay is currently shown. */
export function isOverlayVisible(): boolean {
  return !!overlay && !overlay.isDestroyed() && overlay.isVisible();
}

/** Create (if needed) and show the overlay once its content has loaded, so it
 *  never flashes a blank window before the renderer paints. */
export function showOverlay(): BrowserWindow {
  const w = createOverlayWindow();
  w.show(); // show immediately so it's always visible
  // ...and re-show once content is ready, in case the first show preceded paint.
  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) w.show();
    });
  }
  return w;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null;
}

export function setOverlayMode(mode: OverlayMode): void {
  const w = getOverlayWindow();
  if (!w) return;
  const size = SIZES[mode];
  w.setBounds({ ...w.getBounds(), ...size });
}
