import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ParsedResume } from '@shared/types';

// Capture the request body passed to responses.create and feed back a fixed JSON
// reply. Mock the model resolver so models.ts → db → better-sqlite3 never loads.
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

import { generateStories, COMPETENCIES } from './stories';

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

function input(over: Partial<Parameters<typeof generateStories>[0]> = {}) {
  return { targetRole: 'Staff SWE', resume, resumeText: 'Full résumé text here', ...over };
}

const systemPrompt = () =>
  String(h.lastBody!.system);
const userPrompt = () =>
  String(h.lastBody!.user);

const story = (over: Record<string, unknown> = {}) => ({
  title: 'Rebuilt the ledger',
  situation: 'Payments errors were high.',
  task: 'I owned the ledger.',
  action: 'I redesigned the reconciliation flow.',
  result: 'Cut errors 90%.',
  competencies: ['impact', 'ownership'],
  skills: ['Node', 'Postgres'],
  ...over,
});

beforeEach(() => {
  h.lastBody = null;
  h.reply = JSON.stringify({ stories: [story()] });
});

describe('generateStories — request', () => {
  it('uses the parsing model and asks for JSON', async () => {
    await generateStories(input());
    expect(h.lastBody!.task).toBe('parsing');
  });

  it('instructs grounding-only STAR extraction with the closed competency set', async () => {
    await generateStories(input());
    const s = systemPrompt();
    expect(s).toMatch(/never invent|ground/i);
    expect(s).toMatch(/STAR/);
    // The exact competency vocabulary is injected so tags stay closed.
    for (const c of COMPETENCIES) expect(s).toContain(c);
  });

  it('feeds the parsed résumé + raw text into the prompt', async () => {
    await generateStories(input());
    const u = userPrompt();
    expect(u).toContain('distributed systems');
    expect(u).toContain('Full résumé text here');
    expect(u).toContain('Staff SWE');
  });
});

describe('generateStories — defensive parsing', () => {
  it('returns parsed story drafts', async () => {
    const out = await generateStories(input());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Rebuilt the ledger',
      result: 'Cut errors 90%.',
      competencies: ['impact', 'ownership'],
      skills: ['Node', 'Postgres'],
    });
  });

  it('clamps competencies to the closed set and drops invalid tags', async () => {
    h.reply = JSON.stringify({ stories: [story({ competencies: ['impact', 'made-up', 'synergy'] })] });
    const out = await generateStories(input());
    expect(out[0].competencies).toEqual(['impact']);
  });

  it('drops incomplete stories (missing title/situation/action/result)', async () => {
    h.reply = JSON.stringify({
      stories: [
        story(), // complete
        story({ title: '' }), // no title
        story({ result: '' }), // no result
        { situation: 'orphan' }, // missing most fields
      ],
    });
    const out = await generateStories(input());
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Rebuilt the ledger');
  });

  it('defaults to empty when the model returns no stories array', async () => {
    h.reply = '{}';
    expect(await generateStories(input())).toEqual([]);
  });

  it('filters non-string skills', async () => {
    h.reply = JSON.stringify({ stories: [story({ skills: ['Node', 7, null, 'Go'] })] });
    const out = await generateStories(input());
    expect(out[0].skills).toEqual(['Node', 'Go']);
  });
});
