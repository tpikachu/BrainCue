import { IPC, EVENTS } from '@shared/ipc';
import { handle, NoInput } from './helpers';
import { broadcast } from './broadcast';
import { confirmInWindow } from '../services/ui/confirm';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { sessionsRepo } from '../db/repositories/sessions.repo';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { loadSampleData } from '../services/samples/sampleData';
import { apiKeyStore } from '../services/security/apiKey';
import { sessionManager } from '../services/session/sessionManager';
import { log } from '../services/security/logger';

/** An in-window confirm (NOT a native dialog — that's a separate OS window that
 *  shows in a screen share). Returns true if confirmed. Gates destructive actions
 *  in the main process, so they can't run without explicit user consent even if
 *  the IPC is invoked directly. */
export async function confirmDestructive(opts: {
  message: string;
  detail: string;
  confirmLabel: string;
}): Promise<boolean> {
  return confirmInWindow({
    title: opts.message,
    detail: opts.detail,
    confirmLabel: opts.confirmLabel,
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
}

export function registerDataIpc(): void {
  // Lightweight counts for the dashboard sidebar status panel.
  handle(IPC.data.stats, NoInput, () => {
    const { total, live } = sessionsRepo.count();
    return {
      profiles: profilesRepo.count(),
      interviews: jobsRepo.count(),
      sessions: total,
      liveSessions: live,
    };
  });

  // Remove ALL user data: the OpenAI API key + every profile and session (FK
  // cascade wipes documents, notes, jobs, chunks, embeddings, transcripts,
  // questions, answers and reports). Settings are untouched (see settings:reset-app).
  handle(IPC.data.wipeAll, NoInput, async () => {
    const ok = await confirmDestructive({
      message: 'Remove all user data?',
      detail:
        'This permanently deletes your OpenAI API key, all profiles, and all interview sessions and reports. This cannot be undone.',
      confirmLabel: 'Delete everything',
    });
    if (!ok) return { wiped: false };

    sessionManager.shutdown(); // stop any live session before deleting its rows
    apiKeyStore.clear();
    profilesRepo.deleteAll();
    sessionsRepo.deleteAll(); // belt-and-suspenders (cascade already covers these)
    log.info('data wipe: api key cleared, all profiles and sessions deleted');

    broadcast(EVENTS.dataChanged, { reason: 'wipe' });
    return { wiped: true };
  });

  // Seed a sample profile + a few realistic interviews so users can try the flow.
  handle(IPC.data.loadSamples, NoInput, async () => {
    const res = await loadSampleData();
    broadcast(EVENTS.dataChanged, { reason: 'samples' });
    return res;
  });
}
