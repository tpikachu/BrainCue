import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'path';
import { appEvents, APP_EVENT } from '../appEvents';
import { getPrivacy, setPrivacy } from '../services/session/privacy';
import { showOverlay } from './overlayWindow';
import { navigateMainWindow, showMainWindow } from './mainWindow';
import { confirmQuit } from '../quit';
import { log } from '../services/security/logger';

let tray: Tray | null = null;

/** The app icon on disk, resolvable in both dev and a packaged build.
 *  `resources/icon.png` is shipped via electron-builder `extraResources`. */
function iconImage(): Electron.NativeImage {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png');
  // Resize to a tray-appropriate size; the source is 1024×1024.
  return nativeImage.createFromPath(path).resize({ width: 16, height: 16 });
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Show AI Assistant', click: () => showMainWindow() },
    { label: 'Show Overlay', click: () => showOverlay() },
    { type: 'separator' },
    {
      label: 'Privacy Mode (hide from screen share)',
      type: 'checkbox',
      checked: getPrivacy(),
      click: () => setPrivacy(!getPrivacy()),
    },
    { label: 'Settings', click: () => navigateMainWindow('/settings') },
    { type: 'separator' },
    { label: 'Exit', click: () => void confirmQuit() },
  ]);
}

/** Refresh the tray menu so its checkbox state (e.g. Privacy Mode) reflects
 *  changes made elsewhere (overlay button, global shortcut, Settings). */
export function updateTrayMenu(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

export function createTray(): Tray {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(iconImage());
  tray.setToolTip('AI Interview Assistant');
  tray.setContextMenu(buildMenu());
  // Single-click (Windows) / click anywhere brings the dashboard forward.
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());

  // Keep the Privacy Mode checkbox in sync with toggles from anywhere.
  appEvents.on(APP_EVENT.privacyChanged, updateTrayMenu);

  log.info('tray created');
  return tray;
}

export function destroyTray(): void {
  appEvents.removeListener(APP_EVENT.privacyChanged, updateTrayMenu);
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}
