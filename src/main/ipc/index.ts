import { registerDialogIpc } from './dialog.ipc';
import { registerSettingsIpc } from './settings.ipc';
import { registerProfilesIpc } from './profiles.ipc';
import { registerDocumentsIpc } from './documents.ipc';
import { registerJobsIpc } from './jobs.ipc';
import { registerNotesIpc } from './notes.ipc';
import { registerSessionIpc } from './session.ipc';
import { registerMockIpc } from './mock.ipc';
import { registerCaptureIpc } from './capture.ipc';
import { registerOverlayIpc } from './overlay.ipc';
import { registerWindowIpc } from './window.ipc';
import { registerDataIpc } from './data.ipc';
import { registerUpdateIpc } from './update.ipc';
import { registerDevIpc } from './dev.ipc';

/** Wire every IPC handler. Called once after the DB is initialized. */
export function registerIpc(): void {
  registerDialogIpc();
  registerSettingsIpc();
  registerProfilesIpc();
  registerDocumentsIpc();
  registerJobsIpc();
  registerNotesIpc();
  registerSessionIpc();
  registerMockIpc();
  registerCaptureIpc();
  registerOverlayIpc();
  registerWindowIpc();
  registerDataIpc();
  registerUpdateIpc();
  registerDevIpc(); // no-op in packaged builds
}
