import { chatTaskProblem, chatTaskReady } from '../services/readiness';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { isInterviewSpace } from '@shared/activities';
import { handle, zId, zSpaceKind } from './helpers';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { parseCompany, parseJobDescription, parseResume } from '../services/openai/parsing';
import { generateBrief } from '../services/openai/brief';
import { tailorApplication } from '../services/openai/tailor';
import { fetchCompanySite } from '../services/documents/companyResearch';
import { indexJob, JobEmbeddingError } from '../services/rag/indexProfile';
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
      /** Only Spaces of this activity (server-side, so paging stays exact). */
      activity: zSpaceKind.optional(),
    }),
    ({ profileId, query, limit, offset, activity }) => jobsRepo.page({ profileId, query, limit, offset, activity }),
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
      kind: zSpaceKind.optional(),
      title: z.string().default(''),
      company: z.string().nullable().default(null),
      jdUrl: z.string().nullable().default(null),
      jdText: z.string().nullable().default(null),
      companyUrl: z.string().nullable().default(null),
      notes: z.string().nullable().default(null),
      resumeText: z.string().max(200_000).nullable().optional(),
      tailoredResume: z.null().optional(),
    }),
    async ({ id, profileId, kind, title, company, jdUrl, jdText, companyUrl, notes, resumeText, tailoredResume }) => {
      const previous = id ? jobsRepo.get(id) : null;
      if (id && !previous) throw new Error('Space not found.');
      if (previous && previous.profileId !== profileId) throw new Error('This role belongs to another profile. Choose a role for the current profile.');
      const job = id
        ? jobsRepo.update(id, { kind, title, company, jdUrl, jdText, companyUrl, notes, resumeText, tailoredResume })
        : jobsRepo.create({ profileId, kind, title, company, jdUrl, jdText, companyUrl, notes, resumeText });

      // JD parsing runs on the 'parsing' task's provider (any chat key).
      const hasKey = chatTaskReady('parsing');
      let processingError: string | null = null;
      // Structured JD parsing extracts requirements, responsibilities, and
      // seniority — an interview artifact. Run over a standup agenda it invents
      // all three, so non-job Spaces index their document as plain text.
      const interviewSpace = isInterviewSpace(jobsRepo.get(job.id)?.kind);
      if (jdText?.trim() && interviewSpace) {
        if (jdText !== previous?.jdText) jobsRepo.update(job.id, { parsedJd: null });
        if (hasKey && (jdText !== previous?.jdText || !previous?.parsedJd)) {
          try {
            jobsRepo.update(job.id, { parsedJd: await parseJobDescription(jdText) });
          } catch {
            processingError = 'The job description could not be parsed. Its saved text is still used for answers.';
          }
        }
      } else {
        // JD cleared, or not an interview → drop any parsed structure (chunks
        // are cleared by indexJob either way).
        jobsRepo.update(job.id, { parsedJd: null });
      }

      // Site research: scrape the linked page + parse it into background notes.
      // Best-effort — failures (bot-blocking, no key) don't fail the save.
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
      let embedded = 0;
      try {
        ({ embedded } = await indexJob(job.id));
      } catch (e) {
        if (!(e instanceof JobEmbeddingError)) throw e;
        // indexJob writes the current chunks before embedding. Keeping the
        // saved role and using local matching is preferable to creating a
        // duplicate on retry or retaining its old résumé after a model error.
        processingError = 'Semantic indexing failed. Your saved documents are matched by keywords; save again to retry indexing.';
      }
      return {
        job: jobsRepo.get(job.id)!,
        keyMissing: !hasKey,
        embedded,
        companyResearched,
        companyError,
        processingError,
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
    if (!job) throw new Error('Space not found.');
    // The brief predicts interview questions and coverage gaps against a JD.
    // It has no meaning for a standup or a project.
    if (!isInterviewSpace(job.kind))
      throw new Error('Prep briefs are for interview Spaces.');
    // Runs on the parsing task's provider (any chat key), not only OpenAI.
    if (!chatTaskReady('parsing')) throw new Error(chatTaskProblem('parsing', 'generate a brief'));
    if (!job.parsedJd)
      throw new Error('This interview needs a parsed job description first — add a JD in Detail.');
    const profile = profilesRepo.get(job.profileId);
    if (!profile)
      throw new Error('Profile not found.');
    const ownResume = job.tailoredResume?.trim() || job.resumeText?.trim();
    const resume = ownResume ? await parseResume(ownResume) : profile.parsedResume;
    if (!resume)
      throw new Error('This profile needs a parsed résumé first — add & parse one on the profile.');

    return generateBrief({
      targetRole: profile.targetRole,
      company: job.company,
      resume,
      jd: job.parsedJd,
      companyResearch: job.parsedCompany,
    });
  });

  /**
   * Tailor the profile's résumé to THIS Space's job description, and keep the
   * result on the Space.
   *
   * A tailored résumé is a document about one role at one company, so it
   * belongs to the Space that already holds that role's JD — not to a separate
   * hidden pack the user never sees, which was the old shape and the reason
   * "tailor for this Space" could not be expressed at all.
   *
   * The model call runs BEFORE any write, so a failure leaves the Space exactly
   * as it was. Indexing is best-effort afterwards: the text is the paid result
   * and must survive an embedding hiccup, and re-saving the Space re-indexes.
   */
  handle(IPC.jobs.tailorResume, zId, async ({ id }) => {
    const job = jobsRepo.get(id);
    if (!job) throw new Error('Space not found.');
    if (!isInterviewSpace(job.kind))
      throw new Error('Tailoring a résumé only applies to interview Spaces.');
    if (!apiKeyStore.isPresent())
      throw new Error('Tailoring runs on OpenAI only for now — add an OpenAI key in Settings → Language Models to tailor a résumé.');
    if (!job.jdText?.trim())
      throw new Error('Add this Space’s job description first — there is nothing to tailor to.');
    const profile = profilesRepo.get(job.profileId);
    const baseResume = job.resumeText?.trim() || profile?.resumeText?.trim();
    if (!baseResume)
      throw new Error('This profile has no résumé yet — add one on the profile first.');

    const result = await tailorApplication({
      baseResume,
      jdText: job.jdText,
      questions: [],
    });
    const saved = jobsRepo.update(id, { tailoredResume: result.tailoredResume });

    let embedded = 0;
    let indexError: string | null = null;
    try {
      ({ embedded } = await indexJob(id));
    } catch (e) {
      indexError = (e as Error).message;
      log.warn('tailor: indexing failed, text kept', { jobId: id });
    }
    return { job: saved, embedded, indexError };
  });

  /** Drop it. The Space keeps its JD; sessions fall back to the base résumé on
   *  the next re-index, which this triggers. */
  handle(IPC.jobs.clearTailoredResume, zId, async ({ id }) => {
    const job = jobsRepo.get(id);
    if (!job) throw new Error('Space not found.');
    const saved = jobsRepo.update(id, { tailoredResume: null });
    try {
      await indexJob(id);
    } catch {
      /* the column is already cleared; stale chunks go on the next re-index */
    }
    return { job: saved };
  });

  handle(IPC.jobs.delete, zId, ({ id }) => {
    jobsRepo.delete(id);
    return { deleted: true as const };
  });
}
