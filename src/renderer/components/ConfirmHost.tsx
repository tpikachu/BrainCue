import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ConfirmRequest } from '@shared/ipc';
import { Button, Modal } from './ui';

/**
 * Renders main-initiated confirmations INSIDE the app window — so they inherit
 * Privacy Mode's screen-capture exclusion — instead of a native OS dialog, which
 * is a separate window that shows up in a screen share even while the app itself
 * is hidden. Mounted once at the app root (main.tsx); the dashboard and Cue Card
 * both include it, and main targets exactly one window, so only that window's
 * host ever shows a modal (no duplicates).
 */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => api.events.onConfirmRequest((p) => setReq(p)), []);

  const answer = (ok: boolean): void => {
    if (req) void api.ui.confirmResponse(req.id, ok).catch(() => {});
    setReq(null);
  };

  return (
    // data-ct-interactive: keep it clickable even if the Cue Card has
    // click-through on (mirrors the Overlay's settings modal).
    <div data-ct-interactive>
      <Modal open={!!req} onClose={() => answer(false)} title={req?.title} width="max-w-md">
        {req && (
          <div className="space-y-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
              {req.detail}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => answer(false)}>
                {req.cancelLabel}
              </Button>
              <Button
                variant={req.tone === 'danger' ? 'danger' : 'primary'}
                onClick={() => answer(true)}
              >
                {req.confirmLabel}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
