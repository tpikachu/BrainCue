import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { initDb } from './db';
import { registerIpc } from './ipc';
import { createMainWindow, getMainWindow } from './windows/mainWindow';
import { createOverlayWindow } from './windows/overlayWindow';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts';
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
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createMainWindow();
    }
  });
  startApp();
}

function startApp(): void {
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.aiinterview.assistant');

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
    // Create the overlay up front (kept hidden) so its renderer is loaded and
    // subscribed to IPC events before any answer streams to it. Without this,
    // clipboard/region/hotkey solves triggered with no live session would
    // broadcast their question/answer before the lazily-created overlay had
    // subscribed, and the events would be silently dropped.
    createOverlayWindow();
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  unregisterGlobalShortcuts();
});
}
