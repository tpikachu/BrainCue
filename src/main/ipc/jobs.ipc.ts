import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { parseCompany, parseJobDescription } from '../services/openai/parsing';
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
      if (hasKey && jdText?.trim()) {
        jobsRepo.update(job.id, { parsedJd: await parseJobDescription(jdText) });
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

      const { embedded } = hasKey ? await indexJob(job.id) : { embedded: 0 };
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

  handle(IPC.jobs.delete, zId, ({ id }) => {
    jobsRepo.delete(id);
    return { deleted: true as const };
  });
}
