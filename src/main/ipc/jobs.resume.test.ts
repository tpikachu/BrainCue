import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc';
import { createTestDb } from '../test/dbHarness';

/* eslint-disable @typescript-eslint/no-explicit-any */
const h = vi.hoisted(() => ({
  db: null as unknown as import('../test/dbHarness').TestDb,
  handlers: new Map<string, { schema: any; fn: (input: any) => any }>(),
  parseFails: false,
  embeddingFails: false,
  briefResume: null as any,
  tailorBase: '',
}));
vi.mock('../db', async () => ({ schema: await vi.importActual('../db/schema'), db: () => h.db }));
vi.mock('./helpers', async () => {
  const { z } = await import('zod');
  return { handle: (channel: string, schema: any, fn: any) => h.handlers.set(channel, { schema, fn }), zId: z.object({ id: z.string() }), zSpaceKind: z.enum(['job', 'project']) };
});
vi.mock('../services/readiness', () => ({ chatTaskReady: () => true, chatTaskProblem: () => '' }));
vi.mock('../services/security/apiKey', () => ({ apiKeyStore: { isPresent: () => true } }));
vi.mock('../services/security/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../providers/registry', () => ({ providerFor: () => ({ identity: () => ({ provider: 'fake', model: 'resume-test', dim: 2 }), embed: async (texts: string[]) => { if (h.embeddingFails) throw new Error('embedding unavailable'); return texts.map(() => Float32Array.from([1, 0])); } }) }));
vi.mock('../services/openai/parsing', () => ({
  parseJobDescription: async () => { if (h.parseFails) throw new Error('parsing unavailable'); return { requirements: ['Payments'], responsibilities: [], keywords: [], focusAreas: [] }; },
  parseResume: async (text: string) => ({ skills: [text] }),
  parseCompany: async () => ({}),
}));
vi.mock('../services/openai/brief', () => ({ generateBrief: async (input: any) => { h.briefResume = input.resume; return {}; } }));
vi.mock('../services/openai/tailor', () => ({ tailorApplication: async (input: any) => { h.tailorBase = input.baseResume; return { tailoredResume: `Tailored: ${input.baseResume}` }; } }));
vi.mock('../services/documents/companyResearch', () => ({ fetchCompanySite: async () => ({ text: 'Company' }) }));

import { schema } from '../db';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { registerJobsIpc } from './jobs.ipc';

let seq = 0;
function profile() {
  const id = `resume-profile-${++seq}`;
  h.db.insert(schema.profiles).values({ id, name: 'Candidate', resumeText: 'Default résumé.', parsedResume: JSON.stringify({ skills: ['Default'] }) }).run();
  return id;
}
function invoke(channel: string, input: unknown): Promise<any> {
  const handler = h.handlers.get(channel)!;
  return Promise.resolve(handler.fn(handler.schema.parse(input)));
}
function save(profileId: string, over: Record<string, unknown> = {}) {
  return invoke(IPC.jobs.save, { profileId, kind: 'job', title: 'Payments engineer', ...over });
}
beforeAll(async () => { h.db = (await createTestDb()).db; registerJobsIpc(); });
beforeEach(() => { h.parseFails = false; h.embeddingFails = false; h.briefResume = null; h.tailorBase = ''; });

describe('per-role résumé through the real save/brief/tailor handlers and schema', () => {
  it('persists a role résumé without changing the profile, and omitted updates preserve it', async () => {
    const pid = profile();
    const { job } = await save(pid, { resumeText: 'Payments lead, 42k rps.' });
    expect(job.resumeText).toBe('Payments lead, 42k rps.');
    expect(profilesRepo.get(pid)?.resumeText).toBe('Default résumé.');
    const edited = await save(pid, { id: job.id, title: 'Senior payments engineer' });
    expect(edited.job.resumeText).toBe(job.resumeText);
  });

  it('a parser failure still saves and indexes the current résumé and raw JD', async () => {
    const pid = profile();
    const { job } = await save(pid, { resumeText: 'Old role résumé.', jdText: 'Old JD' });
    h.parseFails = true;
    const result = await save(pid, { id: job.id, resumeText: 'New role résumé.', jdText: 'New payments JD' });
    expect(result.processingError).toContain('could not be parsed');
    expect(result.job.parsedJd).toBeNull();
    const text = h.db.select().from(schema.chunks).all().filter(c => c.packId === job.id).map(c => c.content).join('\n');
    expect(text).toContain('New role résumé.');
    expect(text).toContain('New payments JD');
    expect(text).not.toContain('Old role résumé.');
  });

  it('an embedding failure keeps the saved role and current searchable text, with an explicit partial result', async () => {
    const pid = profile();
    h.embeddingFails = true;
    const result = await save(pid, { resumeText: 'Payments at Custom Corp.' });
    expect(result.processingError).toContain('matched by keywords');
    expect(jobsRepo.list(pid)).toHaveLength(1);
    expect(h.db.select().from(schema.chunks).all().some(c => c.packId === result.job.id && c.content === 'Payments at Custom Corp.')).toBe(true);
  });

  it('prep and tailoring use the résumé selected for the role', async () => {
    const pid = profile();
    const { job } = await save(pid, { resumeText: 'Custom payments background.', jdText: 'Payments JD' });
    await invoke(IPC.jobs.brief, { id: job.id });
    expect(h.briefResume.skills).toEqual(['Custom payments background.']);
    await invoke(IPC.jobs.tailorResume, { id: job.id });
    expect(h.tailorBase).toBe('Custom payments background.');
    expect(jobsRepo.get(job.id)?.resumeText).toBe('Custom payments background.');
    expect(jobsRepo.get(job.id)?.tailoredResume).toBe('Tailored: Custom payments background.');
  });

  it('another profile cannot overwrite a role résumé', async () => {
    const pid = profile();
    const { job } = await save(pid, { resumeText: 'Original role résumé.' });
    await expect(save(profile(), { id: job.id, resumeText: 'Wrong candidate.' })).rejects.toThrow('another profile');
    expect(jobsRepo.get(job.id)?.resumeText).toBe('Original role résumé.');
  });
});
