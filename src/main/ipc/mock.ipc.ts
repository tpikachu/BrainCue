import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { mockManager } from '../services/mock/mockManager';

const voice = z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).default('alloy');
const interviewType = z
  .enum(['behavioral', 'technical', 'coding', 'system_design', 'product', 'sales', 'general'])
  .default('general');

export function registerMockIpc(): void {
  handle(
    IPC.mock.start,
    z.object({
      profileId: z.string().min(1),
      voice,
      jobId: z.string().nullable().default(null),
      interviewType,
    }),
    ({ profileId, voice: v, jobId, interviewType: t }) => mockManager.start(profileId, v, jobId, t),
  );

  handle(IPC.mock.next, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) =>
    mockManager.next(sessionId),
  );

  handle(IPC.mock.end, z.object({ sessionId: z.string().min(1) }), ({ sessionId }) => {
    mockManager.end(sessionId);
    return { ended: true as const };
  });
}
