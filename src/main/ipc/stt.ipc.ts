import { z } from 'zod';
import { EVENTS, IPC } from '@shared/ipc';
import { applySttSelection } from '../services/stt';
import {
  cancelDownload,
  listModelStatuses,
  remove,
  startDownload,
} from '../services/stt/modelStore';
import { broadcast } from './broadcast';
import { handle, NoInput } from './helpers';

/**
 * `stt:*` — local speech-to-text model management (list / download / cancel /
 * delete) and the `stt:download-progress` push. See docs/05-IPC-MAP.md and
 * docs/22-LOCAL-STT.md.
 */

const zModel = z.object({ modelId: z.string().min(1).max(80) });

export function registerSttIpc(): void {
  handle(IPC.stt.listModels, NoInput, () => listModelStatuses());

  // Returns immediately; progress streams on EVENTS.sttDownloadProgress (throttled
  // to ~4 Hz by the downloader). A second call for a running download is a no-op.
  handle(IPC.stt.download, zModel, ({ modelId }) =>
    startDownload(modelId, (p) => {
      broadcast(EVENTS.sttDownloadProgress, p, ['main']);
      // The user may already have picked `local` while the download ran —
      // re-evaluate so the next session uses the model without a restart.
      if (p.state === 'done') applySttSelection();
    }),
  );

  handle(IPC.stt.cancelDownload, zModel, ({ modelId }) => ({
    cancelled: cancelDownload(modelId),
  }));

  handle(IPC.stt.deleteModel, zModel, ({ modelId }) => {
    remove(modelId);
    applySttSelection(); // `local` without a model falls back to the cloud engine
    return { deleted: true };
  });
}
