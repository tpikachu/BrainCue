import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { initDb } from './db';
import { registerIpc } from './ipc';
import { createMainWindow, showMainWindow } from './windows/mainWindow';
import { createOverlayWindow, showOverlay } from './windows/overlayWindow';
import { createSelectionWindow } from './windows/selectionWindow';
import { createTray } from './windows/tray';
import { registerGlobalShortcuts } from './shortcuts';
import { performShutdown } from './quit';
import { getPrivacy } from './services/session/privacy';
import { log } from './services/security/logger';

// Escape hatch for hybrid-GPU laptops (e.g. NVIDIA Optimus) where the GPU surface
// won't display the window: launch with `--disable-gpu` or set `AI_DISABLE_GPU=1`
// to fall back to software rendering. Must run before the app is ready.
if (process.env.AI_DISABLE_GPU === '1' || process.argv.includes('--disable-gpu')) {
  app.disableHardwareAcceleration();
  log.info('GPU hardware acceleration disabled (AI_DISABLE_GPU / --disable-gpu)');
}

// A crashing GPU process can leave a blank/hidden window — log it so it's diagnosable.
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' || details.reason !== 'clean-exit') {
    log.warn(`child-process-gone: ${details.type} (${details.reason})`);
  }
});

// Enforce a single instance. A second launch would fail to register the global
// shortcuts (held by the first) and hit "Access is denied" on the shared disk
// cache — so instead we focus the existing window and quit the duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A duplicate launch just surfaces the existing instance (which may be
    // hidden in the tray) instead of starting a new process.
    showMainWindow();
  });
  startApp();
}

function startApp(): void {
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.braincue.copilot');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // CSP via response headers so it can differ by environment. Production is
  // strict (no inline/remote). Dev must allow Vite's inline preamble script and
  // the HMR websocket, otherwise the renderer is blocked and shows blank.
  const csp = is.dev
    ? "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:*"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });

  // Allow microphone + screen/system-audio capture (live sessions); deny the rest.
  const allowed = new Set(['media', 'display-capture', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // System-audio (loopback) capture for transcribing the interviewer's voice in
  // online calls. getDisplayMedia({audio:true,video:true}) resolves to the
  // primary screen's video + system audio loopback; the renderer keeps only audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  try {
    initDb();
    registerIpc();
    createMainWindow();
    // Create the overlay (Cue Card) up front and show it by default: its renderer
    // is loaded and subscribed to IPC events before any answer streams to it, so
    // clipboard/region/hotkey solves with no live session aren't dropped. It can
    // be toggled with the global shortcut or the tray; closing it hides it.
    createOverlayWindow();
    showOverlay();
    // Pre-create the region selector (hidden) so its renderer is loaded and ready;
    // creating it on demand right after a screen capture made it fail to load.
    createSelectionWindow();
    createTray();
    registerGlobalShortcuts();
    // Build marker: if you DON'T see this line on `npm run dev`, the main process
    // is stale — fully quit Electron and restart so window changes take effect.
    log.info('main build: single-index views + jobs + clipboard-solve');
    log.info(`privacy mode (hidden from capture): ${getPrivacy() ? 'ON' : 'OFF'}`);
  } catch (e) {
    log.error('startup failed', e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// The app intentionally lives in the tray after the dashboard is closed, so we
// do NOT quit when all windows are gone. A real exit goes through the tray
// "Exit" (or OS quit), which sets isQuitting and runs `performShutdown`.
app.on('window-all-closed', () => {
  /* keep running in the tray */
});

// Single place that releases every long-lived resource (Realtime websocket,
// global shortcuts, tray, windows) so no orphaned child processes survive exit.
app.on('before-quit', performShutdown);
}
