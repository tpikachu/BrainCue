import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the request body + drive the model's JSON output; mock the model resolver.
const h = vi.hoisted(() => ({ output: '{}', lastBody: null as Record<string, unknown> | null }));
vi.mock('./client', () => ({
  openai: () => ({
    responses: {
      create: async (body: Record<string, unknown>) => {
        h.lastBody = body;
        return { output_text: h.output };
      },
    },
  }),
}));
vi.mock('./models', () => ({ model: () => 'gpt-4.1-mini' }));

import { parseResume, parseJobDescription, parseCompany } from './parsing';

beforeEach(() => {
  h.output = '{}';
  h.lastBody = null;
});

describe('parseResume', () => {
  it('defaults every field to [] for an empty object', async () => {
    h.output = '{}';
    const r = await parseResume('resume text');
    expect(r).toEqual({
      skills: [],
      projects: [],
      workHistory: [],
      metrics: [],
      education: [],
      certifications: [],
      techStack: [],
      leadership: [],
    });
  });

  it('keeps present fields and defaults the rest', async () => {
    h.output = JSON.stringify({ skills: ['ts', 'go'], metrics: ['+30% perf'] });
    const r = await parseResume('x');
    expect(r.skills).toEqual(['ts', 'go']);
    expect(r.metrics).toEqual(['+30% perf']);
    expect(r.projects).toEqual([]); // missing → default
  });

  it('caps the input text at 24k chars sent to the model', async () => {
    await parseResume('a'.repeat(30_000));
    const userContent = String((h.lastBody!.input as { role: string; content: string }[])[1].content);
    expect(userContent.length).toBe(24_000);
  });
});

describe('parseJobDescription', () => {
  it('defaults all arrays for an empty object', async () => {
    const r = await parseJobDescription('jd');
    expect(r).toEqual({ requirements: [], responsibilities: [], keywords: [], focusAreas: [] });
  });
  it('passes through provided arrays', async () => {
    h.output = JSON.stringify({ requirements: ['5y exp'], keywords: ['react'] });
    const r = await parseJobDescription('jd');
    expect(r.requirements).toEqual(['5y exp']);
    expect(r.keywords).toEqual(['react']);
    expect(r.responsibilities).toEqual([]);
  });
});

describe('parseCompany', () => {
  it('defaults overview to "" (string) and the rest to []', async () => {
    const r = await parseCompany('site text');
    expect(r.overview).toBe('');
    expect(r).toMatchObject({
      products: [],
      techStack: [],
      values: [],
      culture: [],
      recentNews: [],
      interviewAngles: [],
    });
  });
  it('keeps a provided overview string', async () => {
    h.output = JSON.stringify({ overview: 'We build payments infra.', products: ['API'] });
    const r = await parseCompany('x');
    expect(r.overview).toBe('We build payments infra.');
    expect(r.products).toEqual(['API']);
  });
});
