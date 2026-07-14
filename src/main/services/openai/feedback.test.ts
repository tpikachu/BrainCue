import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job, Profile } from '@shared/types';

// Capture the request body and feed back a fixed JSON reply. Mock the model
// resolver so models.ts → db → better-sqlite3 never loads.
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

import { evaluateAnswer } from './feedback';

const profile = {
  targetRole: 'Staff SWE',
  targetCompany: 'Acme',
  parsedResume: {
    skills: ['distributed systems'],
    projects: [{ name: 'Payments', description: '', impact: '' }],
    workHistory: [],
    metrics: ['p99 latency −40%'],
    education: [],
    certifications: [],
    techStack: [],
    leadership: [],
  },
  resumeText: null,
} as unknown as Profile;

function input(over: Partial<Parameters<typeof evaluateAnswer>[0]> = {}) {
  return {
    question: 'Tell me about a hard scaling problem.',
    answer: 'I rebuilt the ledger and cut latency.',
    profile,
    job: null as Job | null,
    interviewType: 'behavioral' as const,
    ...over,
  };
}

const systemPrompt = () =>
  String((h.lastBody!.input as { role: string; content: string }[])[0].content);
const userPrompt = () =>
  String((h.lastBody!.input as { role: string; content: string }[])[1].content);

const FULL = JSON.stringify({
  verdict: 'Solid, but light on metrics.',
  rating: 4,
  strengths: ['Clear structure'],
  improvements: ['Quantify the impact'],
  tip: 'Mention your p99 latency −40% result.',
  competency: 'impact',
});

beforeEach(() => {
  h.lastBody = null;
  h.reply = FULL;
});

describe('evaluateAnswer — request', () => {
  it('uses the mock model and asks for JSON', async () => {
    await evaluateAnswer(input());
    expect(h.lastBody!.model).toBe('model:mock');
    expect(h.lastBody!.text).toEqual({ format: { type: 'json_object' } });
  });

  it('grounds the critique (no fabrication) and includes the question + answer', async () => {
    await evaluateAnswer(input());
    expect(systemPrompt()).toMatch(/never invent|only what they actually said/i);
    const u = userPrompt();
    expect(u).toContain('Tell me about a hard scaling problem.');
    expect(u).toContain('I rebuilt the ledger and cut latency.');
    expect(u).toContain('distributed systems'); // résumé context
  });

  it('passes a placeholder when the answer is empty', async () => {
    await evaluateAnswer(input({ answer: '   ' }));
    expect(userPrompt()).toContain('(no answer captured)');
  });
});

describe('evaluateAnswer — defensive parsing', () => {
  it('returns the parsed feedback', async () => {
    const f = await evaluateAnswer(input());
    expect(f).toEqual({
      verdict: 'Solid, but light on metrics.',
      rating: 4,
      strengths: ['Clear structure'],
      improvements: ['Quantify the impact'],
      tip: 'Mention your p99 latency −40% result.',
      competency: 'impact',
    });
  });

  it('degrades an off-list competency to null (closed set)', async () => {
    h.reply = JSON.stringify({ competency: 'vibes' });
    expect((await evaluateAnswer(input())).competency).toBeNull();
    h.reply = JSON.stringify({ competency: 'ownership' });
    expect((await evaluateAnswer(input())).competency).toBe('ownership');
  });

  it('asks the model to classify the competency from the closed set', async () => {
    await evaluateAnswer(input());
    expect(systemPrompt()).toMatch(/competency/i);
    expect(systemPrompt()).toContain('technical_depth'); // the list is spelled out
  });

  it('clamps rating into 1–5 and rounds', async () => {
    h.reply = JSON.stringify({ rating: 9 });
    expect((await evaluateAnswer(input())).rating).toBe(5);
    h.reply = JSON.stringify({ rating: 0 });
    expect((await evaluateAnswer(input())).rating).toBe(1);
    h.reply = JSON.stringify({ rating: 3.6 });
    expect((await evaluateAnswer(input())).rating).toBe(4);
  });

  it('defaults a missing/non-numeric rating to 3 and arrays to empty', async () => {
    h.reply = '{}';
    const f = await evaluateAnswer(input());
    expect(f).toEqual({
      verdict: '',
      rating: 3,
      strengths: [],
      improvements: [],
      tip: '',
      competency: null,
    });
    h.reply = JSON.stringify({ rating: 'great' });
    expect((await evaluateAnswer(input())).rating).toBe(3);
  });

  it('filters non-string strengths/improvements', async () => {
    h.reply = JSON.stringify({ strengths: ['ok', 2, null], improvements: [true, 'fix this'] });
    const f = await evaluateAnswer(input());
    expect(f.strengths).toEqual(['ok']);
    expect(f.improvements).toEqual(['fix this']);
  });
});
