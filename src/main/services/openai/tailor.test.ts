import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the request body passed to responses.create and feed back a fixed JSON
// reply. Mock the model resolver so models.ts → db → better-sqlite3 never loads.
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
vi.mock('./models', () => ({
  model: (k: string) => `model:${k}`,
  reasoningParam: () => ({}),
}));

import { tailorApplication } from './tailor';

function input(over: Partial<Parameters<typeof tailorApplication>[0]> = {}) {
  return {
    baseResume: 'Jane Doe\nSWE at Acme. Cut p99 latency 40% with a Node cache layer.',
    jdText: 'Senior Backend Engineer at Globex. Requires Node.js and caching at scale.',
    questions: ['Why do you want to work here?'],
    ...over,
  };
}

const systemPrompt = () =>
  String((h.lastBody!.input as { role: string; content: string }[])[0].content);
const userPrompt = () =>
  String((h.lastBody!.input as { role: string; content: string }[])[1].content);

const FULL = JSON.stringify({
  candidateName: 'Jane Doe',
  jobTitle: 'Senior Backend Engineer',
  company: 'Globex',
  tailoredResume: '# Jane Doe\n\n## Summary\nBackend engineer…',
  answers: [{ question: 'Why do you want to work here?', answer: 'Because…' }],
});

beforeEach(() => {
  h.lastBody = null;
  h.reply = FULL;
});

describe('tailorApplication — request', () => {
  it('uses the tailor model and asks for JSON', async () => {
    await tailorApplication(input());
    expect(h.lastBody!.model).toBe('model:tailor');
    expect(h.lastBody!.text).toEqual({ format: { type: 'json_object' } });
  });

  it('mandates grounding + ATS structure in the system prompt', async () => {
    await tailorApplication(input());
    const s = systemPrompt();
    expect(s).toMatch(/NEVER invent/i);
    expect(s).toMatch(/ATS/i);
    expect(s).toMatch(/no tables/i);
  });

  it('feeds the base resume, JD, and numbered questions into the prompt', async () => {
    await tailorApplication(input());
    const u = userPrompt();
    expect(u).toContain('Cut p99 latency 40%');
    expect(u).toContain('Senior Backend Engineer at Globex');
    expect(u).toContain('1. Why do you want to work here?');
  });

  it('marks the questions section empty when none are given', async () => {
    await tailorApplication(input({ questions: [] }));
    expect(userPrompt()).toContain('APPLICATION QUESTIONS: (none)');
  });
});

describe('tailorApplication — defensive parsing', () => {
  it('returns the parsed result', async () => {
    const r = await tailorApplication(input());
    expect(r).toEqual({
      candidateName: 'Jane Doe',
      jobTitle: 'Senior Backend Engineer',
      company: 'Globex',
      tailoredResume: '# Jane Doe\n\n## Summary\nBackend engineer…',
      answers: [{ question: 'Why do you want to work here?', answer: 'Because…' }],
    });
  });

  it('throws when the model returns no tailored resume (nothing gets persisted)', async () => {
    h.reply = JSON.stringify({ candidateName: 'X', answers: [] });
    await expect(tailorApplication(input())).rejects.toThrow(/no resume/i);
  });

  it('defaults missing name/title/company to empty strings', async () => {
    h.reply = JSON.stringify({ tailoredResume: '# R' });
    const r = await tailorApplication(input());
    expect(r).toMatchObject({ candidateName: '', jobTitle: '', company: '', answers: [] });
  });

  it('drops malformed answer entries (missing question or answer)', async () => {
    h.reply = JSON.stringify({
      tailoredResume: '# R',
      answers: [{ question: 'Q1' }, { answer: 'orphan' }, { question: 'Q2', answer: 'A2' }, 7],
    });
    const r = await tailorApplication(input());
    expect(r.answers).toEqual([{ question: 'Q2', answer: 'A2' }]);
  });
});
