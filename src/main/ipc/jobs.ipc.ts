import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { parseCompany, parseJobDescription } from '../services/openai/parsing';
import { generateBrief } from '../services/openai/brief';
import { fetchCompanySite } from '../services/documents/companyResearch';
import { indexJob } from '../services/rag/indexProfile';
import { apiKeyStore } from '../services/security/apiKey';
import { log } from '../services/security/logger';

export function registerJobsIpc(): void {
  handle(IPC.jobs.list, z.object({ profileId: z.string().min(1) }), ({ profileId }) =>
    jobsRepo.list(profileId),
  );

  handle(
    IPC.jobs.page,
    z.object({
      profileId: z.string().min(1),
      query: z.string().default(''),
      limit: z.number().int().min(1).max(100).default(5),
      offset: z.number().int().min(0).default(0),
    }),
    ({ profileId, query, limit, offset }) => jobsRepo.page({ profileId, query, limit, offset }),
  );

  handle(IPC.jobs.get, zId, ({ id }) => {
    const job = jobsRepo.get(id);
    if (!job) throw new Error('Job not found');
    return job;
  });

  // Create (no id) or update (with id), then parse the JD + index it (if a key
  // is set). Each job is parsed independently of the resume and other jobs.
  handle(
    IPC.jobs.save,
    z.object({
      id: z.string().optional(),
      profileId: z.string().min(1),
      title: z.string().default(''),
      company: z.string().nullable().default(null),
      jdUrl: z.string().nullable().default(null),
      jdText: z.string().nullable().default(null),
      companyUrl: z.string().nullable().default(null),
      notes: z.string().nullable().default(null),
    }),
    async ({ id, profileId, title, company, jdUrl, jdText, companyUrl, notes }) => {
      const job = id
        ? jobsRepo.update(id, { title, company, jdUrl, jdText, companyUrl, notes })
        : jobsRepo.create({ profileId, title, company, jdUrl, jdText, companyUrl, notes });

      const hasKey = apiKeyStore.isPresent();
      if (jdText?.trim()) {
        if (hasKey) jobsRepo.update(job.id, { parsedJd: await parseJobDescription(jdText) });
      } else {
        // JD cleared → drop its parsed structure (chunks are cleared by indexJob).
        jobsRepo.update(job.id, { parsedJd: null });
      }

      // Company research: scrape the website + parse it into interview-relevant
      // notes. Best-effort — failures (bot-blocking, no key) don't fail the save.
      let companyResearched = false;
      let companyError: string | null = null;
      const trimmedCompanyUrl = companyUrl?.trim();
      if (!trimmedCompanyUrl) {
        // URL cleared → drop any prior research so it isn't re-indexed.
        jobsRepo.update(job.id, { companyResearch: null, parsedCompany: null });
      } else if (hasKey) {
        try {
          const site = await fetchCompanySite(trimmedCompanyUrl);
          jobsRepo.update(job.id, {
            companyResearch: site.text,
            parsedCompany: await parseCompany(site.text),
          });
          companyResearched = true;
        } catch (e) {
          companyError = (e as Error).message;
          log.warn('jobs:save: company research failed', companyError);
        }
      }

      // Always reindex: clears stale JD/company chunks (+ embeddings) even with no
      // key, and re-embeds when a key + text are present.
      const { embedded } = await indexJob(job.id);
      return {
        job: jobsRepo.get(job.id)!,
        keyMissing: !hasKey,
        embedded,
        companyResearched,
        companyError,
      };
    },
  );

  // Lightweight: update only the free-form client notes (no JD re-parse / re-index).
  handle(
    IPC.jobs.setNotes,
    z.object({ id: z.string().min(1), notes: z.string().nullable() }),
    ({ id, notes }) => jobsRepo.update(id, { notes }),
  );

  // Per-Space companion behavior overrides (null = inherit the global config).
  handle(
    IPC.jobs.setCompanionPrefs,
    z.object({
      id: z.string().min(1),
      prefs: z
        .object({
          tone: z.enum(['warm', 'neutral', 'direct']).optional(),
          brevity: z.enum(['terse', 'normal', 'chatty']).optional(),
          humor: z.boolean().optional(),
          presence: z.enum(['off', 'on_demand', 'assistive', 'proactive']).optional(),
        })
        .nullable(),
    }),
    ({ id, prefs }) => jobsRepo.setCompanionPrefs(id, prefs ?? null),
  );

  // Generate a grounded pre-interview brief from the profile's résumé × the job's
  // JD × any company research. Reuses the parsed structures (no re-parse); returns
  // the brief to the renderer (not persisted — it's regenerated on demand).
  handle(IPC.jobs.brief, zId, async ({ id }) => {
    const job = jobsRepo.get(id);
    if (!job) throw new Error('Interview not found.');
    if (!apiKeyStore.isPresent())
      throw new Error('Add your OpenAI API key in Settings to generate a brief.');
    if (!job.parsedJd)
      throw new Error('This interview needs a parsed job description first — add a JD in Detail.');
    const profile = profilesRepo.get(job.profileId);
    if (!profile?.parsedResume)
      throw new Error('This profile needs a parsed résumé first — add & parse one on the profile.');

    return generateBrief({
      targetRole: profile.targetRole,
      company: job.company,
      resume: profile.parsedResume,
      jd: job.parsedJd,
      companyResearch: job.parsedCompany,
    });
  });

  handle(IPC.jobs.delete, zId, ({ id }) => {
    jobsRepo.delete(id);
    return { deleted: true as const };
  });
}
