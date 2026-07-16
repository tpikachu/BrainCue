import { z } from 'zod';
import { clipboard } from 'electron';
import { IPC } from '@shared/ipc';
import { handle, NoInput } from './helpers';
import {
  createOverlayWindow,
  getOverlayWindow,
  isOverlayVisible,
  setOverlayMode,
} from '../windows/overlayWindow';
import { getPrivacy, privacySupported, requestPrivacy, togglePrivacyGuarded } from '../services/session/privacy';

export function registerOverlayIpc(): void {
  handle(IPC.overlay.show, NoInput, () => {
    createOverlayWindow().show();
    return { visible: true };
  });

  handle(IPC.overlay.hide, NoInput, () => {
    getOverlayWindow()?.hide();
    return { visible: false };
  });

  handle(IPC.overlay.toggle, NoInput, () => {
    const w = createOverlayWindow();
    const visible = !w.isVisible();
    visible ? w.show() : w.hide();
    return { visible };
  });

  handle(IPC.overlay.isVisible, NoInput, () => ({ visible: isOverlayVisible() }));

  handle(IPC.overlay.setMode, z.object({ mode: z.enum(['compact', 'expanded']) }), ({ mode }) => {
    setOverlayMode(mode);
    return { mode };
  });

  handle(
    IPC.overlay.setOpacity,
    z.object({ opacity: z.number().min(0).max(1) }),
    ({ opacity }) => {
      getOverlayWindow()?.setOpacity(opacity);
      return { opacity };
    },
  );

  handle(
    IPC.overlay.setClickthrough,
    z.object({ enabled: z.boolean() }),
    ({ enabled }) => {
      getOverlayWindow()?.setIgnoreMouseEvents(enabled, { forward: true });
      return { enabled };
    },
  );

  // Write text to the OS clipboard from the renderer (the overlay's per-card "Copy").
  // Routed through main because the renderer's clipboard-write permission is denied.
  handle(IPC.overlay.copyText, z.object({ text: z.string() }), ({ text }) => {
    clipboard.writeText(text);
    return { copied: true as const };
  });

  handle(IPC.privacy.get, NoInput, () => ({ enabled: getPrivacy(), supported: privacySupported }));
  // Disabling privacy is gated by a confirmation dialog (see requestPrivacy).
  handle(IPC.privacy.toggle, NoInput, async () => ({ enabled: await togglePrivacyGuarded() }));
  handle(IPC.privacy.set, z.object({ enabled: z.boolean() }), async ({ enabled }) => ({
    enabled: await requestPrivacy(enabled),
  }));
}
