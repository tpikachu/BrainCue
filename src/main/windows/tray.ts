import { Menu, Tray } from 'electron';
import { appEvents, APP_EVENT } from '../appEvents';
import { getPrivacy, requestPrivacy } from '../services/session/privacy';
import { getShortcuts } from '../shortcuts';
import { appIconImage } from './appIcon';
import { showOverlay } from './overlayWindow';
import { navigateMainWindow, showMainWindow } from './mainWindow';
import { confirmQuit } from '../quit';
import { log } from '../services/security/logger';

let tray: Tray | null = null;

/** Tray-sized app icon (source is 1024×1024). */
function iconImage(): Electron.NativeImage {
  return appIconImage().resize({ width: 16, height: 16 });
}

function buildMenu(): Menu {
  // Show each item's configured global shortcut on the right. `registerAccelerator:
  // false` makes it display-only — the globalShortcut registration already handles
  // firing, so the tray must not re-register (or fight over) the accelerator.
  const sc = getShortcuts();
  return Menu.buildFromTemplate([
    { label: 'Show BrainCue Dashboard', click: () => showMainWindow() },
    {
      label: 'Show BrainCue Cue Card',
      accelerator: sc['overlay:toggle'],
      registerAccelerator: false,
      click: () => showOverlay(),
    },
    { type: 'separator' },
    {
      label: 'Privacy Mode (hide from screen share)',
      type: 'checkbox',
      checked: getPrivacy(),
      accelerator: sc['privacy:toggle'],
      registerAccelerator: false,
      // Turning privacy OFF is confirmed first; restore the checkbox afterwards so
      // it matches the real state whether the user confirmed or cancelled.
      click: () => void requestPrivacy(!getPrivacy()).finally(updateTrayMenu),
    },
    { label: 'Settings', click: () => navigateMainWindow('/settings') },
    { type: 'separator' },
    {
      label: 'Exit BrainCue Copilot',
      accelerator: sc['app:quit'],
      registerAccelerator: false,
      click: () => void confirmQuit(),
    },
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
  tray.setToolTip('BrainCue Copilot');
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
