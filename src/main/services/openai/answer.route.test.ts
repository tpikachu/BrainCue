import { describe, expect, it, vi } from 'vitest';

/**
 * M7.2b / PERF-01: a short technical answer stays on the interactive
 * `answer` task. Neither the Technical style, a technical interview, nor a
 * technical/system-design/coding question type moves a live answer onto the
 * coding solver's slower, deeper-reasoning route; the style only changes the
 * prompt and the output ceiling. (Reasoning effort for `answer` is the
 * model's lowest — providers/effort.ts, LIVE_TASKS.)
 */
const h = vi.hoisted(() => ({ requests: [] as { task: string; maxOutputTokens?: number }[] }));

vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    async *stream(req: { task: string; maxOutputTokens?: number }) {
      h.requests.push({ task: req.task, maxOutputTokens: req.maxOutputTokens });
      yield { type: 'delta', token: 'I would use a token bucket.' };
    },
  }),
}));

import { streamAnswer } from './answer';
import type { InterviewType } from '@shared/types';

const profile = { targetRole: 'SWE', targetCompany: 'Acme', name: 'Alex' } as Parameters<typeof streamAnswer>[0]['profile'];

describe('live answers keep the interactive route whatever the technical framing', () => {
  it.each([
    ['general', 'general', 'behavioral', 360],
    ['technical', 'technical', 'technical_concept', 600],
    ['technical', 'system_design', 'system_design', 600],
    ['technical', 'coding', 'coding', 600],
    ['general', 'technical', 'technical_concept', 360],
  ] as const)('style %s · %s interview · %s question → task "answer", ceiling %i', async (format, interviewType, questionType, ceiling) => {
    h.requests.length = 0;
    for await (const _ of streamAnswer({
      question: 'How would you rate-limit a public API?',
      contextChunks: [],
      profile,
      format,
      pronunciation: false,
      interviewType: interviewType as InterviewType,
      questionType,
    })) {
      /* drain */
    }
    expect(h.requests).toEqual([{ task: 'answer', maxOutputTokens: ceiling }]);
  });
});
