import { chatTaskReady } from '../services/readiness';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { extractText } from '../services/documents/extract';
import { fetchUrlText } from '../services/documents/fetchUrl';
import { parseResume } from '../services/openai/parsing';
import { reindexProfile } from '../services/rag/indexProfile';
import { profilesRepo } from '../db/repositories/profiles.repo';

export function registerDocumentsIpc(): void {
  // Extract text from a file WITHOUT persisting — used to populate the editor's
  // text box so the user reviews before saving.
  handle(
    IPC.documents.extractFile,
    z.object({ filePath: z.string().min(1) }),
    async ({ filePath }) => {
      const { text, mime } = await extractText(filePath);
      const filename = filePath.split(/[\\/]/).pop() ?? 'document';
      return { text, mime, filename };
    },
  );

  // Best-effort: download a (job-posting) URL and return its readable text so
  // the user can review it before saving. Nothing is persisted here.
  handle(
    IPC.documents.fetchUrl,
    z.object({ url: z.string().min(1) }),
    ({ url }) => fetchUrlText(url),
  );

  // Save the resume text and (when a key exists) parse it + reindex the profile
  // base (resume + notes). JD lives on jobs and is parsed independently.
  handle(
    IPC.documents.saveResume,
    z.object({ profileId: z.string().min(1), resumeText: z.string() }),
    async ({ profileId, resumeText }) => {
      // Parsing runs on whichever provider the 'parsing' task resolves to —
      // not only OpenAI (services/readiness.ts chatTaskReady).
      const hasKey = chatTaskReady('parsing');
      const hasText = !!resumeText.trim();
      // Save the text; clearing the resume also drops its parsed structure.
      profilesRepo.update(profileId, { resumeText, ...(hasText ? {} : { parsedResume: null }) });
      if (hasKey && hasText) {
        profilesRepo.update(profileId, { parsedResume: await parseResume(resumeText) });
      }
      // Always reindex: it clears stale base chunks (+ their embeddings) even with
      // no key, and re-embeds when a key + resume text are present.
      const { embedded } = await reindexProfile(profileId);
      return { keyMissing: !hasKey, parsed: hasKey && hasText, embedded };
    },
  );

  handle(
    IPC.documents.reindexProfile,
    z.object({ profileId: z.string().min(1) }),
    ({ profileId }) => reindexProfile(profileId),
  );
}
