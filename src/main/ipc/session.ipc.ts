import { z } from 'zod';
import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { zAnswerFormat, zInterviewType, zPresence, zSessionMode } from './schemas';
import { sessionManager } from '../services/session/sessionManager';
import { engine } from '../services/engine/engine';
import { sessionsRepo } from '../db/repositories/sessions.repo';
import { generateReport } from '../services/session/report';
import { getOrGenerateMeetingReport } from '../services/engine/meetingReport';
import { voiceService } from '../services/voice/voiceService';

const interviewType = zInterviewType;
const answerFormat = zAnswerFormat;

export function registerSessionIpc(): void {
  handle(
    IPC.session.start,
    z.object({
      profileId: z.string().min(1),
      interviewType,
      jobId: z.string().nullable().default(null),
      answerFormat: answerFormat.default('key_points'),
      // v2: which engine mode runs the session (default keeps v1 semantics)
      // and, for ambient modes, how present the companion should be.
      mode: zSessionMode.default('interview'),
      presence: zPresence.optional(),
      // Companion cost governance: hard session budget in cents (null = none;
      // absent = the companion prefs default).
      budgetCents: z.number().int().positive().nullable().optional(),
      // Explicit start-time companion posture (off/on_demand/assistive/proactive).
      companionPresence: z.enum(['off', 'on_demand', 'assistive', 'proactive']).optional(),
    }),
    ({
      profileId,
      interviewType: t,
      jobId,
      answerFormat: f,
      mode,
      presence,
      budgetCents,
      companionPresence,
    }) =>
      sessionManager.start(profileId, t, jobId, f, { mode, presence, budgetCents, companionPresence }),
  );

  // Live posture change for the active ambient session (companion presence
  // select in the Cue Card). Vocabulary is validated by the policy itself.
  handle(
    IPC.session.setPresence,
    z.object({ presence: z.string().min(1) }),
    ({ presence }) => engine.setPresenceActive(presence),
  );

  handle(
    IPC.session.meetingReport,
    z.object({ sessionId: z.string().min(1) }),
    ({ sessionId }) => getOrGenerateMeetingReport(sessionId),
  );

  handle(
    IPC.session.resume,
    z.object({
      sessionId: z.string().min(1),
      answerFormat: answerFormat.default('key_points'),
    }),
    ({ sessionId, answerFormat: f }) => sessionManager.resume(sessionId, f),
  );

  handle(IPC.session.stop, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) => {
    voiceService.cancel(); // a stopping session takes any in-flight voice turn with it
    return sessionManager.stop(sessionId);
  });

  handle(
    IPC.session.togglePause,
    z.object({ sessionId: z.string().min(1) }),
    ({ sessionId }) => {
      const r = sessionManager.togglePause(sessionId);
      voiceService.syncSessionPaused(r.paused); // hard pause silences voice too
      return r;
    },
  );

  handle(IPC.session.togglePauseActive, z.void(), () => {
    const r = sessionManager.togglePauseActive();
    if (r.active) voiceService.syncSessionPaused(r.paused);
    return r;
  });

  handle(IPC.session.stopActive, z.void(), () => {
    voiceService.cancel();
    return sessionManager.stopActive();
  });

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

  handle(IPC.session.regenerate, z.object({ questionId: z.string().optional() }), ({ questionId }) =>
    sessionManager.regenerate(questionId),
  );

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

  handle(IPC.session.practiceStats, z.void(), () => sessionsRepo.practiceStats());
}
