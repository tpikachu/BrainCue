import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { zInterviewType, zTtsVoice } from './schemas';
import { sparringManager } from '../services/mock/sparringManager';

const voice = zTtsVoice.default('alloy');
const interviewType = zInterviewType.default('general');

export function registerSparringIpc(): void {
  handle(
    IPC.sparring.start,
    z.object({
      profileId: z.string().min(1),
      voice,
      jobId: z.string().nullable().default(null),
      interviewType,
    }),
    ({ profileId, voice: v, jobId, interviewType: t }) =>
      sparringManager.start(profileId, v, jobId, t),
  );

  handle(
    IPC.sparring.answer,
    z.object({
      sessionId: z.string().min(1),
      audioBase64: z.string().min(1),
      mime: z.string().default('audio/webm'),
    }),
    ({ sessionId, audioBase64, mime }) => sparringManager.answer(sessionId, audioBase64, mime),
  );

  handle(IPC.sparring.next, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) =>
    sparringManager.next(sessionId),
  );

  handle(IPC.sparring.end, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) => {
    sparringManager.end(sessionId);
    return { ended: true as const };
  });
}
