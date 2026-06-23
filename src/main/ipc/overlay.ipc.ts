import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, NoInput } from './helpers';
import {
  createOverlayWindow,
  getOverlayWindow,
  isOverlayVisible,
  setOverlayMode,
} from '../windows/overlayWindow';
import { getPrivacy, setPrivacy, togglePrivacy } from '../services/session/privacy';

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

  handle(IPC.privacy.get, NoInput, () => ({ enabled: getPrivacy() }));
  handle(IPC.privacy.toggle, NoInput, () => ({ enabled: togglePrivacy() }));
  handle(IPC.privacy.set, z.object({ enabled: z.boolean() }), ({ enabled }) => ({
    enabled: setPrivacy(enabled),
  }));
}
