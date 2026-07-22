import { registerDialogIpc } from './dialog.ipc';
import { registerSettingsIpc } from './settings.ipc';
import { registerProfilesIpc } from './profiles.ipc';
import { registerDocumentsIpc } from './documents.ipc';
import { registerJobsIpc } from './jobs.ipc';
import { registerApplicationsIpc } from './applications.ipc';
import { registerNotesIpc } from './notes.ipc';
import { registerStoriesIpc } from './stories.ipc';
import { registerSessionIpc } from './session.ipc';
import { registerContributionsIpc } from './contributions.ipc';
import { registerMemoryIpc } from './memory.ipc';
import { registerMockIpc } from './mock.ipc';
import { registerSparringIpc } from './sparring.ipc';
import { registerCaptureIpc } from './capture.ipc';
import { registerOverlayIpc } from './overlay.ipc';
import { registerWindowIpc } from './window.ipc';
import { registerDataIpc } from './data.ipc';
import { registerUpdateIpc } from './update.ipc';
import { registerDevIpc } from './dev.ipc';
import { registerConfirmIpc } from '../services/ui/confirm';

/** Wire every IPC handler. Called once after the DB is initialized. */
export function registerIpc(): void {
  registerDialogIpc();
  registerSettingsIpc();
  registerProfilesIpc();
  registerDocumentsIpc();
  registerJobsIpc();
  registerApplicationsIpc();
  registerNotesIpc();
  registerStoriesIpc();
  registerSessionIpc();
  registerContributionsIpc();
  registerMemoryIpc();
  registerMockIpc();
  registerSparringIpc();
  registerCaptureIpc();
  registerOverlayIpc();
  registerWindowIpc();
  registerDataIpc();
  registerUpdateIpc();
  registerConfirmIpc();
  registerDevIpc(); // no-op in packaged builds
}
