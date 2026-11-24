import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M2 review: with an OpenAI key and a keyless Anthropic ANSWER override,
 * practice reported ready and a mock started — then could never write its
 * answer cues. The mock's own readiness now includes the answer task, and
 * start() refuses BEFORE any session row or live session exists.
 */
const h = vi.hoisted(() => ({
  inserted: 0,
  goLive: 0,
  notReady: new Set<string>(),
}));

vi.mock('../../db', () => ({
  db: () => ({
    insert: () => ({ values: () => ({ run: () => void h.inserted++ }) }),
  }),
  schema: { sessions: {} },
}));
vi.mock('../../db/repositories/profiles.repo', () => ({ profilesRepo: { get: () => ({ id: 'p1', language: 'en' }) } }));
vi.mock('../../db/repositories/jobs.repo', () => ({ jobsRepo: { get: () => null } }));
vi.mock('../openai/interviewer', () => ({ generateQuestion: async () => 'Q?' }));
vi.mock('../openai/tts', () => ({ speak: async () => Buffer.from('') }));
vi.mock('../session/sessionManager', () => ({ sessionManager: { goLive: () => void h.goLive++, answerQuestion: async () => {} } }));
vi.mock('../security/apiKey', () => ({ apiKeyStore: { isPresent: () => true } }));
vi.mock('../readiness', () => ({
  chatTaskReady: (task: string) => !h.notReady.has(task),
  chatTaskProblem: (task: string, toDo: string) => `${task} problem — to ${toDo}`,
}));

import { mockManager } from './mockManager';

beforeEach(() => {
  h.inserted = 0;
  h.goLive = 0;
  h.notReady.clear();
});

describe('mock start checks every model it depends on before creating anything', () => {
  it('the answer model cannot run → refused with its fix; no row, no live session', async () => {
    h.notReady.add('answer');
    await expect(mockManager.start('p1', 'alloy' as never)).rejects.toThrow(/answer problem — to write the answer cues in a mock interview/);
    expect(h.inserted).toBe(0);
    expect(h.goLive).toBe(0);
  });

  it('the question (mock) model cannot run → refused likewise', async () => {
    h.notReady.add('mock');
    await expect(mockManager.start('p1', 'alloy' as never)).rejects.toThrow(/mock problem/);
    expect(h.inserted).toBe(0);
    expect(h.goLive).toBe(0);
  });
});
