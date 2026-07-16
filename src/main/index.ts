import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { initDb } from './db';
import { registerIpc } from './ipc';
import { sparringManager } from './services/mock/sparringManager';
import { createMainWindow, showMainWindow } from './windows/mainWindow';
import { createOverlayWindow, showOverlay } from './windows/overlayWindow';
import { createSelectionWindow } from './windows/selectionWindow';
import { createLoopbackAnchor, LOOPBACK_ANCHOR_TITLE } from './windows/loopbackAnchor';
import { createTray } from './windows/tray';
import { registerGlobalShortcuts } from './shortcuts';
import { performShutdown } from './quit';
import { applyContentProtectionToAll, getPrivacy } from './services/session/privacy';
import { initAutoUpdate } from './services/update/updater';
import { log } from './services/security/logger';

// Escape hatch for hybrid-GPU laptops (e.g. NVIDIA Optimus) where the GPU surface
// won't display the window: launch with `--disable-gpu` or set `AI_DISABLE_GPU=1`
// to fall back to software rendering. Must run before the app is ready.
if (process.env.AI_DISABLE_GPU === '1' || process.argv.includes('--disable-gpu')) {
  app.disableHardwareAcceleration();
  log.info('GPU hardware acceleration disabled (AI_DISABLE_GPU / --disable-gpu)');
}

// E2E: isolate the on-disk data dir so Playwright tests never touch the real user
// DB. Must run before the app is ready / before the DB opens (db path derives from
// userData). No effect in normal use.
if (process.env.E2E_USER_DATA) {
  app.setPath('userData', process.env.E2E_USER_DATA);
}

// E2E: the harness drives the app over the Chrome DevTools Protocol. Playwright's
// own _electron launcher passes `--remote-debugging-port=0` as a CLI flag, which
// Electron 30+ rejects ("bad option" — microsoft/playwright#39008), so the harness
// spawns us directly and we open a fixed CDP port here via appendSwitch (which
// Electron DOES honor). Gated on the E2E flag — never enabled in normal use.
if (process.env.BRAINCUE_E2E) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.E2E_CDP_PORT || '9222');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
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
  // online calls. We need `audio: 'loopback'`, which getDisplayMedia only grants
  // alongside a VIDEO source — but if that video is the SCREEN, Chromium clears
  // WDA_EXCLUDEFROMCAPTURE on all of THIS process's windows for the whole capture
  // (the Cue Card + dashboard then show up in Zoom/Meet). So we point the video
  // at a tiny off-screen anchor WINDOW instead (createLoopbackAnchor): a window
  // capture only clears the exclusion once, at capture-start, so re-asserting it
  // afterwards sticks. The renderer discards the video track and keeps only audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['window', 'screen'] })
        .then((sources) => {
          const anchor = sources.find((s) => s.name === LOOPBACK_ANCHOR_TITLE);
          if (!anchor) log.warn('loopback anchor window not found; falling back to screen capture (may reveal windows)');
          callback({ video: anchor ?? sources[0], audio: 'loopback' });
          // Capture-start clears our windows' capture-exclusion once; restore it a
          // few times over the next few seconds (window capture makes it durable —
          // no watchdog, no flicker). Tied to the real event, not a timer loop.
          for (const ms of [250, 600, 1000, 1600, 2400, 3500]) {
            setTimeout(() => applyContentProtectionToAll(getPrivacy()), ms);
          }
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  try {
    initDb();
    // Quitting from the Sparring page skips React cleanup, so a drill can leave
    // its session row 'live' — finalize such strays before any UI reads counts.
    sparringManager.healStrays();
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
    // The off-screen video source for system-audio (loopback) capture — created up
    // front so it's enumerable the instant a live session starts. See its handler.
    createLoopbackAnchor();
    createTray();
    registerGlobalShortcuts();
    // Build marker: if you DON'T see this line on `npm run dev`, the main process
    // is stale — fully quit Electron and restart so window changes take effect.
    log.info('main build: single-index views + jobs + clipboard-solve');
    log.info(`privacy mode (hidden from capture): ${getPrivacy() ? 'ON' : 'OFF'}`);
    // Check for updates in the background (packaged builds only) and let the
    // renderer prompt a restart once a new version is downloaded.
    initAutoUpdate();
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
