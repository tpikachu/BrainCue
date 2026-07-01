import { z } from 'zod';
import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { sessionManager } from '../services/session/sessionManager';
import { sessionsRepo } from '../db/repositories/sessions.repo';
import { generateReport } from '../services/session/report';

const interviewType = z.enum([
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'product',
  'sales',
  'general',
]);
const answerFormat = z.enum(['key_points', 'explanation', 'detailed']);

export function registerSessionIpc(): void {
  handle(
    IPC.session.start,
    z.object({
      profileId: z.string().min(1),
      interviewType,
      jobId: z.string().nullable().default(null),
      answerFormat: answerFormat.default('key_points'),
    }),
    ({ profileId, interviewType: t, jobId, answerFormat: f }) =>
      sessionManager.start(profileId, t, jobId, f),
  );

  handle(
    IPC.session.resume,
    z.object({
      sessionId: z.string().min(1),
      answerFormat: answerFormat.default('key_points'),
    }),
    ({ sessionId, answerFormat: f }) => sessionManager.resume(sessionId, f),
  );

  handle(IPC.session.stop, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) =>
    sessionManager.stop(sessionId),
  );

  handle(
    IPC.session.togglePause,
    z.object({ sessionId: z.string().min(1) }),
    ({ sessionId }) => sessionManager.togglePause(sessionId),
  );

  handle(IPC.session.togglePauseActive, z.void(), () => sessionManager.togglePauseActive());

  handle(IPC.session.stopActive, z.void(), () => sessionManager.stopActive());

  handle(
    IPC.session.audioChunk,
    z.object({
      sessionId: z.string().min(1),
      audio: z.instanceof(ArrayBuffer),
      mime: z.string().default('audio/webm'),
    }),
    async ({ sessionId, audio, mime }) => {
      await sessionManager.ingestAudio(sessionId, audio, mime);
      return { accepted: true as const };
    },
  );

  // High-frequency streaming PCM audio: fire-and-forget (no Result envelope).
  ipcMain.on(IPC.session.realtimeAudio, (_e, payload: { sessionId: string; pcm: ArrayBuffer }) => {
    if (payload?.sessionId && payload.pcm) {
      sessionManager.feedRealtimeAudio(payload.sessionId, payload.pcm);
    }
  });

  handle(
    IPC.session.ask,
    z.object({ sessionId: z.string().min(1), questionText: z.string().min(1) }),
    ({ sessionId, questionText }) =>
      // fire-and-forget; answer streams over events
      sessionManager.answerQuestion(sessionId, questionText),
  );

  // Live Cue Card controls — act on the active session (no id needed).
  handle(
    IPC.session.setAnswerPrefs,
    z.object({
      interviewType: interviewType.optional(),
      format: answerFormat.optional(),
      pronunciation: z.boolean().optional(),
    }),
    (prefs) => sessionManager.setAnswerPrefs(prefs),
  );

  handle(
    IPC.session.askActive,
    z.object({ questionText: z.string().min(1) }),
    ({ questionText }) => sessionManager.askActive(questionText),
  );

  handle(
    IPC.session.setInterviewType,
    z.object({ sessionId: z.string().min(1), interviewType }),
    ({ sessionId, interviewType: t }) => {
      sessionsRepo.setInterviewType(sessionId, t);
      return { ok: true as const };
    },
  );

  handle(
    IPC.session.setAnswering,
    z.object({ enabled: z.boolean() }),
    ({ enabled }) => sessionManager.setAnsweringActive(enabled),
  );

  handle(IPC.session.regenerate, z.void(), () => sessionManager.regenerateActive());

  handle(IPC.session.clearAnswer, z.void(), () => sessionManager.clearAnswerActive());

  handle(IPC.session.list, z.void(), () => sessionsRepo.list());

  handle(IPC.session.get, zId, ({ id }) => {
    const detail = sessionsRepo.detail(id);
    if (!detail) throw new Error('Session not found');
    return detail;
  });

  handle(IPC.session.delete, zId, ({ id }) => {
    sessionsRepo.delete(id);
    return { deleted: true as const };
  });

  handle(
    IPC.session.generateReport,
    z.object({ sessionId: z.string().min(1) }),
    ({ sessionId }) => generateReport(sessionId),
  );

  handle(
    IPC.session.getReport,
    z.object({ sessionId: z.string().min(1) }),
    ({ sessionId }) => sessionsRepo.getReport(sessionId),
  );
}
