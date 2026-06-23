import { app, nativeImage } from 'electron';
import { join } from 'path';

/** Path to the app icon on disk, resolvable in dev and a packaged build.
 *  `resources/icon.png` ships via electron-builder `extraResources`. We use the
 *  PNG (not .ico) because it's the asset guaranteed to be present at runtime in
 *  both environments and loads fine as a window/tray icon on every platform. */
export function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png');
}

/** The app icon as a NativeImage (e.g. for BrowserWindow `icon`). */
export function appIconImage(): Electron.NativeImage {
  return nativeImage.createFromPath(appIconPath());
}
