import { BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { attachDiagnostics, loadRenderer } from './loadRenderer';
import { applyPrivacyToWindow } from '../services/session/privacy';
import { log } from '../services/security/logger';

let win: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Hide from screen capture when Privacy Mode is on (default). Re-apply on show:
  // on Windows, display affinity is most reliable once the window is realized.
  applyPrivacyToWindow(win);

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

  win.on('show', () => applyPrivacyToWindow(win!));

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  attachDiagnostics(win, 'dashboard');
  loadRenderer(win, 'dashboard');

  win.on('closed', () => (win = null));
  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return win;
}
