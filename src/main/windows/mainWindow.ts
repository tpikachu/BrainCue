import { BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { EVENTS } from '@shared/ipc';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { applyPrivacyToWindow, protectWindow } from '../services/session/privacy';
import { broadcastMaximizeState } from '../ipc/window.ipc';
import { appIconImage } from './appIcon';
import { isQuitting } from '../quit';
import { log } from '../services/security/logger';
import { settingsRepo, SETTINGS_KEYS } from '../db/repositories/settings.repo';

let win: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  const hideTaskbarIcon = settingsRepo.get(SETTINGS_KEYS.hideTaskbarIcon) === '1';
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: hideTaskbarIcon, // stealth: keep the app off the taskbar
    // App icon for the taskbar / Alt-Tab (otherwise the default Electron icon
    // shows in dev). In a packaged build the exe icon is set by electron-builder.
    icon: appIconImage(),
    // Hide the OS titlebar but KEEP the native resizable frame/shadow/snapping
    // (unlike frame:false). The dashboard draws its own titlebar (Titlebar.tsx)
    // with custom min/maximize/close controls and a drag region.
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep audio capture (the live interview mic) running at full rate when the
      // window is minimized/hidden to tray — the user works from the Cue Card.
      backgroundThrottling: false,
    },
  });

  // Hide from screen capture when Privacy Mode is on (default). Set once (and
  // on show); an OS-side wipe of the exclusion is detected and healed by the
  // protection observer (see startProtectionObserver in privacy.ts).
  protectWindow(win);

  // Reveal the window exactly once. On some hybrid-GPU laptops (e.g. NVIDIA
  // Optimus on MSI machines) `ready-to-show` can be delayed or never fire, which
  // would leave the app running with no visible window. So we reveal on the first
  // of: ready-to-show, did-finish-load, or a safety-net timeout — the app must
  // never be an invisible process.
  let shown = false;
  const reveal = (reason: string) => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    applyPrivacyToWindow(win);
    win.show();
    win.focus();
    log.info(`main window shown (${reason})`);
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('fallback-timeout'), 5000);


  // Keep the custom titlebar's maximize/restore icon in sync with the real state.
  broadcastMaximizeState(win);

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the dashboard does NOT quit the app — it keeps living in the tray
  // (closing only frees the taskbar button). A real quit (tray "Exit", Cmd+Q)
  // sets `isQuitting()` first, so we let the window actually close then.
  win.on('close', (e) => {
    if (!isQuitting() && win && !win.isDestroyed()) {
      e.preventDefault();
      win.hide();
    }
  });

  attachDiagnostics(win, 'dashboard');
  loadRenderer(win, 'dashboard');

  win.on('closed', () => (win = null));
  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return win;
}

/** Bring the dashboard to the front, recreating it if it was destroyed. */
export function showMainWindow(): BrowserWindow {
  const w = win && !win.isDestroyed() ? win : createMainWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
}

/** Show the dashboard and ask the renderer to navigate to a route (tray menu). */
export function navigateMainWindow(path: string): void {
  const w = showMainWindow();
  const send = (): void => {
    if (!w.isDestroyed()) w.webContents.send(EVENTS.navigate, { path });
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}
