import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { applicationsRepo } from '../db/repositories/applications.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { jobsRepo } from '../db/repositories/jobs.repo';
import { tailorApplication } from '../services/openai/tailor';
import { parseJobDescription, parseResume } from '../services/openai/parsing';
import { indexJob, reindexProfile } from '../services/rag/indexProfile';
import { apiKeyStore } from '../services/security/apiKey';

export function registerApplicationsIpc(): void {
  handle(
    IPC.applications.page,
    z.object({
      query: z.string().default(''),
      limit: z.number().int().min(1).max(100).default(8),
      offset: z.number().int().min(0).default(0),
    }),
    ({ query, limit, offset }) => applicationsRepo.page({ query, limit, offset }),
  );

  handle(IPC.applications.get, zId, ({ id }) => {
    const app = applicationsRepo.get(id);
    if (!app) throw new Error('Application not found');
    return app;
  });

  // The Tailor Resume operation. ALL model calls run first — nothing is persisted
  // unless they succeed — then: (create profile for an uploaded base resume) →
  // dedicated job (JD) → application row → indexJob (embeds jd + tailored chunks).
  handle(
    IPC.applications.tailor,
    z.object({
      profileId: z.string().nullable().default(null), // existing profile as the base…
      baseResumeText: z.string().nullable().default(null), // …or an uploaded/pasted resume
      jdText: z.string().min(1),
      questions: z.array(z.string()).default([]),
    }),
    async ({ profileId, baseResumeText, jdText, questions }) => {
      if (!apiKeyStore.isPresent())
        throw new Error('Add your OpenAI API key in Settings to tailor a resume.');

      // Resolve the BASE resume text.
      let baseResume: string;
      const existing = profileId ? profilesRepo.get(profileId) : null;
      if (profileId) {
        if (!existing) throw new Error('Profile not found.');
        if (!existing.resumeText?.trim())
          throw new Error('This profile has no resume text — add one, or upload a resume.');
        baseResume = existing.resumeText;
      } else {
        if (!baseResumeText?.trim())
          throw new Error('Select a profile or provide the base resume text.');
        baseResume = baseResumeText;
      }

      // Model calls first (tailor + JD parse + resume parse for a new profile), so a
      // failure here leaves the database untouched.
      const result = await tailorApplication({
        baseResume,
        jdText,
        questions: questions.map((q) => q.trim()).filter(Boolean),
      });
      const parsedJd = await parseJobDescription(jdText);
      const parsedResume = existing ? null : await parseResume(baseResume);

      // Uploaded base resume → materialize a real, reusable profile for it (sessions
      // and jobs both require an owning profile).
      let owner = existing;
      if (!owner) {
        owner = profilesRepo.create({
          name: result.candidateName || 'Imported resume',
          targetRole: result.jobTitle,
          targetCompany: result.company || null,
          interviewType: 'general',
          language: 'en',
          resumeText: baseResume,
          jdText: null,
        });
        profilesRepo.update(owner.id, { parsedResume });
        await reindexProfile(owner.id);
      }

      // The application's dedicated job: holds the JD + (via indexJob) the tailored
      // chunks. Hidden from the regular Interviews table.
      const job = jobsRepo.create({
        profileId: owner.id,
        title: result.jobTitle || 'Untitled role',
        company: result.company || null,
        jdUrl: null,
        jdText,
        companyUrl: null,
        notes: null,
      });
      jobsRepo.update(job.id, { parsedJd });

      const app = applicationsRepo.create({
        profileId: owner.id,
        jobId: job.id,
        name: result.candidateName || owner.name,
        jobTitle: result.jobTitle,
        company: result.company || null,
        baseResume,
        tailoredResume: result.tailoredResume,
        answers: result.answers,
      });

      // Embed JD + tailored chunks. If embedding fails the app still exists; its
      // sessions fall back to base-resume grounding until a re-index succeeds.
      const { embedded } = await indexJob(job.id);
      return { application: app, embedded };
    },
  );

  handle(IPC.applications.delete, zId, ({ id }) => {
    applicationsRepo.delete(id);
    return { deleted: true as const };
  });
}
