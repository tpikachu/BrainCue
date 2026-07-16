import { BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EVENTS, IPC, type ConfirmRequest } from '@shared/ipc';
import { handle } from '../../ipc/helpers';
import { getMainWindow } from '../../windows/mainWindow';
import { getOverlayWindow } from '../../windows/overlayWindow';
import { log } from '../security/logger';

export interface ConfirmOptions {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: ConfirmRequest['tone'];
}

// Pending confirms keyed by id → resolver. Resolved by the renderer's reply
// (IPC.ui.confirmResponse), the host window closing, or the timeout.
const pending = new Map<string, (ok: boolean) => void>();

const CONFIRM_TIMEOUT_MS = 2 * 60_000;

/** Pick a PROTECTED window to host the confirm so it inherits Privacy Mode's
 *  capture exclusion: the focused app window if it's visible, else a visible
 *  main/overlay, else surface the main (or overlay) window — hidden-to-tray is
 *  fine, it's still content-protected. null only if no renderer window exists. */
function hostWindow(): BrowserWindow | null {
  const main = getMainWindow();
  const overlay = getOverlayWindow();
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused &&
    !focused.isDestroyed() &&
    focused.isVisible() &&
    (focused === main || focused === overlay)
  ) {
    return focused;
  }
  if (main && !main.isDestroyed() && main.isVisible()) return main;
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) return overlay;
  if (main && !main.isDestroyed()) {
    main.show(); // surface the dashboard (protected) so the confirm is seen
    return main;
  }
  if (overlay && !overlay.isDestroyed()) {
    overlay.show();
    return overlay;
  }
  return null;
}

/**
 * Show a confirm dialog INSIDE a protected app window (so it inherits Privacy
 * Mode's screen-capture exclusion) and await the user's choice. This replaces
 * native `dialog.showMessageBox`, whose OS dialog is a SEPARATE window with no
 * capture exclusion — it shows up in a screen share even while the app itself is
 * hidden. Falls back to the native dialog only when the app has no renderer
 * window at all to host the modal (so a confirm is never silently skipped).
 */
export function confirmInWindow(opts: ConfirmOptions): Promise<boolean> {
  const win = hostWindow();
  if (!win) {
    return dialog
      .showMessageBox({
        type: opts.tone === 'question' ? 'question' : 'warning',
        buttons: [opts.confirmLabel, opts.cancelLabel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: opts.title,
        message: opts.title,
        detail: opts.detail,
      })
      .then((r) => r.response === 0);
  }

  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      pending.delete(id);
      clearTimeout(timer);
      win.off('closed', onClosed);
      resolve(ok);
    };
    const onClosed = (): void => finish(false); // host window gone → cancel
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
    pending.set(id, finish);
    win.once('closed', onClosed);
    const payload: ConfirmRequest = { id, ...opts };
    win.webContents.send(EVENTS.confirmRequest, payload);
  });
}

/** Wire the renderer's reply channel. Registered once at startup. */
export function registerConfirmIpc(): void {
  handle(IPC.ui.confirmResponse, z.object({ id: z.string(), ok: z.boolean() }), ({ id, ok }) => {
    const resolve = pending.get(id);
    if (resolve) resolve(ok);
    else log.warn(`[ui] confirm response for unknown id ${id} (already resolved/timed out)`);
    return { ok: true as const };
  });
}
