import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ParsedCompany, ParsedJd, ParsedResume } from '@shared/types';

// Capture the request body passed to responses.create and feed back a fixed
// JSON reply. Mock the model resolver so models.ts → db → better-sqlite3 is never
// loaded (it can't load under the vitest node env).
const h = vi.hoisted(() => ({
  lastBody: null as Record<string, unknown> | null,
  reply: '{}',
}));
// Capture the routed request (chatTask.ts) and feed back a fixed JSON reply.
vi.mock('./chatTask', () => ({
  chatJson: async (req: Record<string, unknown>) => {
    h.lastBody = req;
    return JSON.parse(h.reply);
  },
}));

import { generateBrief } from './brief';

const resume: ParsedResume = {
  skills: ['TypeScript', 'distributed systems'],
  projects: [{ name: 'Payments', description: 'Rebuilt the ledger', impact: 'cut errors 90%' }],
  workHistory: [{ company: 'Acme', role: 'SWE', highlights: ['led migration'] }],
  metrics: ['p99 latency −40%'],
  education: [],
  certifications: [],
  techStack: ['Node', 'Postgres'],
  leadership: [],
};
const jd: ParsedJd = {
  requirements: ['Kubernetes in production', '5y backend'],
  responsibilities: ['own the payments platform'],
  keywords: ['Go', 'k8s'],
  focusAreas: ['reliability'],
};
const company: ParsedCompany = {
  overview: 'A fintech',
  products: ['Wallet'],
  techStack: ['Go'],
  values: ['customer obsession'],
  culture: [],
  recentNews: ['Series C'],
  interviewAngles: ['mention payments scale'],
};

function input(over: Partial<Parameters<typeof generateBrief>[0]> = {}) {
  return { targetRole: 'Staff SWE', company: 'Acme', resume, jd, companyResearch: company, ...over };
}

const systemPrompt = () =>
  String(h.lastBody!.system);
const userPrompt = () =>
  String(h.lastBody!.user);

const FULL = JSON.stringify({
  summary: 'Reliability-focused backend round.',
  likelyQuestions: [{ question: 'Walk me through the ledger rebuild.', why: 'résumé project' }],
  gaps: [
    { requirement: 'Kubernetes in production', coverage: 'missing', howToAddress: 'study k8s' },
    { requirement: '5y backend', coverage: 'strong', howToAddress: '' },
  ],
  strengths: [{ point: 'Payments depth', evidence: 'cut errors 90%' }],
  companyAngles: ['tie answers to Wallet scale'],
});

beforeEach(() => {
  h.lastBody = null;
  h.reply = FULL;
});

describe('generateBrief — request', () => {
  it('uses the parsing model and asks for JSON', async () => {
    await generateBrief(input());
    expect(h.lastBody!.task).toBe('parsing');
  });

  it('instructs grounding-only (no fabrication) in the system prompt', async () => {
    await generateBrief(input());
    expect(systemPrompt()).toMatch(/never invent|ground/i);
  });

  it('feeds the parsed résumé, JD, and company research into the prompt', async () => {
    await generateBrief(input());
    const u = userPrompt();
    expect(u).toContain('distributed systems'); // résumé skill
    expect(u).toContain('Kubernetes in production'); // JD requirement
    expect(u).toContain('mention payments scale'); // company angle
    expect(u).toContain('Staff SWE'); // target role
  });
});

describe('generateBrief — defensive parsing', () => {
  it('returns the full shape with parsed content', async () => {
    const b = await generateBrief(input());
    expect(b.summary).toBe('Reliability-focused backend round.');
    expect(b.likelyQuestions).toHaveLength(1);
    expect(b.gaps).toHaveLength(2);
    expect(b.strengths[0]).toEqual({ point: 'Payments depth', evidence: 'cut errors 90%' });
    expect(b.companyAngles).toEqual(['tie answers to Wallet scale']);
  });

  it('normalizes coverage and preserves strong/missing', async () => {
    h.reply = JSON.stringify({
      gaps: [
        { requirement: 'a', coverage: 'missing' },
        { requirement: 'b', coverage: 'strong' },
        { requirement: 'c', coverage: 'who-knows' },
      ],
    });
    const b = await generateBrief(input());
    expect(b.gaps.map((g) => g.coverage)).toEqual(['missing', 'strong', 'partial']);
    expect(b.gaps[0].howToAddress).toBe(''); // missing field defaulted
  });

  it('defaults to empty arrays when the model returns nothing usable', async () => {
    h.reply = '{}';
    const b = await generateBrief(input());
    expect(b).toEqual({
      summary: '',
      likelyQuestions: [],
      gaps: [],
      strengths: [],
      companyAngles: [],
    });
  });

  it('drops malformed items (no question text, non-string angle)', async () => {
    h.reply = JSON.stringify({
      likelyQuestions: [{ why: 'orphan' }, { question: 'Real?', why: '' }],
      companyAngles: ['ok', 42, null],
    });
    const b = await generateBrief(input());
    expect(b.likelyQuestions).toEqual([{ question: 'Real?', why: '' }]);
    expect(b.companyAngles).toEqual(['ok']);
  });

  it('works with no company research (null)', async () => {
    h.reply = FULL;
    const b = await generateBrief(input({ companyResearch: null }));
    expect(userPrompt()).toContain('"companyResearch":null');
    expect(b.summary).toBeTruthy();
  });
});
