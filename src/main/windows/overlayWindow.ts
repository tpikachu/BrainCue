import { BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { EVENTS } from '@shared/ipc';
import { SETTINGS_KEYS, settingsRepo } from '../db/repositories/settings.repo';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { applyPrivacyToWindow } from '../services/session/privacy';
import { getMainWindow } from './mainWindow';
import type { OverlayMode } from '@shared/types';

let overlay: BrowserWindow | null = null;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Margin from the screen edge for the default (bottom-right) placement.
const EDGE_MARGIN = 24;

/** Bottom-right of the primary display's work area, at the default size. */
function defaultBounds(): Bounds {
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = SIZES.compact;
  return {
    width,
    height,
    x: Math.round(wa.x + wa.width - width - EDGE_MARGIN),
    y: Math.round(wa.y + wa.height - height - EDGE_MARGIN),
  };
}

/** True if the window's center sits within some connected display — so a window
 *  saved on a now-disconnected monitor doesn't open off-screen. */
function isOnScreen(b: Bounds): boolean {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height;
  });
}

/** Restore the last saved Cue Card geometry, falling back to the bottom-right
 *  default (first run, or a saved monitor that's no longer connected). */
function initialBounds(): Bounds {
  const saved = settingsRepo.getJson<Bounds | null>(SETTINGS_KEYS.overlayBounds, null);
  if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && isOnScreen(saved)) {
    return saved;
  }
  return defaultBounds();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Persist the current geometry (debounced) so size + position survive restarts. */
function scheduleSaveBounds(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (overlay && !overlay.isDestroyed()) {
      settingsRepo.setJson(SETTINGS_KEYS.overlayBounds, overlay.getBounds());
    }
  }, 400);
}

/** Tell the dashboard whether the overlay is currently visible, so its
 *  "Show/Hide overlay" button reflects toggles from the hotkey, tray, the
 *  overlay's own close button, or a session ending. */
function notifyVisibility(visible: boolean): void {
  getMainWindow()?.webContents.send(EVENTS.overlayVisibility, { visible });
}

const SIZES: Record<OverlayMode, { width: number; height: number }> = {
  compact: { width: 440, height: 460 },
  expanded: { width: 520, height: 680 },
};

/** Created once at startup (and idempotent thereafter); kept hidden when not in
 *  use so its renderer is always loaded and ready to receive streamed answers. */
export function createOverlayWindow(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;

  overlay = new BrowserWindow({
    ...initialBounds(), // restored geometry, or bottom-right default on first run
    minWidth: 360,
    minHeight: 240,
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

  // Persist the Cue Card's size + position (debounced) so they survive restarts.
  overlay.on('move', scheduleSaveBounds);
  overlay.on('resize', scheduleSaveBounds);

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
  const cur = w.getBounds();
  // Anchor the bottom-right corner (the card's default home) so growing to the
  // expanded size doesn't push it off the bottom/right edge, then clamp on-screen.
  const next: Bounds = {
    width: size.width,
    height: size.height,
    x: cur.x + cur.width - size.width,
    y: cur.y + cur.height - size.height,
  };
  w.setBounds(clampToWorkArea(next));
}

/** Keep a window fully inside the work area of the display it's mostly on. */
function clampToWorkArea(b: Bounds): Bounds {
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    width: b.width,
    height: b.height,
    x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)),
    y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)),
  };
}
