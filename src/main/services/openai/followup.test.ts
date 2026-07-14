import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lastBody: null as Record<string, unknown> | null,
  reply: '{}',
}));
vi.mock('./client', () => ({
  openai: () => ({
    responses: {
      create: (body: Record<string, unknown>) => {
        h.lastBody = body;
        return { output_text: h.reply };
      },
    },
  }),
}));
vi.mock('./models', () => ({ model: (k: string) => `model:${k}` }));

import { predictFollowup } from './followup';

const input = {
  question: 'Tell me about a hard scaling problem.',
  answer: 'I rebuilt the ingestion pipeline and cut p99 latency 84%.',
  interviewType: 'behavioral',
};

beforeEach(() => {
  h.lastBody = null;
  h.reply = JSON.stringify({ followup: 'How did you measure that 84% improvement?' });
});

describe('predictFollowup', () => {
  it('runs on the fast classify tier with a bounded output and JSON format', async () => {
    await predictFollowup(input);
    expect(h.lastBody!.model).toBe('model:classify');
    expect(h.lastBody!.text).toEqual({ format: { type: 'json_object' } });
    expect(h.lastBody!.max_output_tokens).toBe(100);
  });

  it('includes the question and the answer in the prompt', async () => {
    await predictFollowup(input);
    const user = String((h.lastBody!.input as { content: string }[])[1].content);
    expect(user).toContain('Tell me about a hard scaling problem.');
    expect(user).toContain('cut p99 latency 84%');
  });

  it('returns the predicted follow-up', async () => {
    expect(await predictFollowup(input)).toBe('How did you measure that 84% improvement?');
  });

  it('returns null for a null/empty/malformed prediction', async () => {
    h.reply = JSON.stringify({ followup: null });
    expect(await predictFollowup(input)).toBeNull();
    h.reply = JSON.stringify({ followup: '   ' });
    expect(await predictFollowup(input)).toBeNull();
    h.reply = 'not json at all';
    expect(await predictFollowup(input)).toBeNull();
  });
});
