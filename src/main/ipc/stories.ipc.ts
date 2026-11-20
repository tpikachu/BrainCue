import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { storiesRepo } from '../db/repositories/stories.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { generateStories } from '../services/openai/stories';
import { indexStories, replaceStories } from '../services/rag/indexProfile';
import { chatTaskProblem, chatTaskReady } from '../services/readiness';

const zProfileId = z.object({ profileId: z.string().min(1) });

// Only the STAR text is user-editable; competencies/skills are set by generation.
const storyPatch = z.object({
  title: z.string().optional(),
  situation: z.string().optional(),
  task: z.string().optional(),
  action: z.string().optional(),
  result: z.string().optional(),
});

export function registerStoriesIpc(): void {
  handle(IPC.stories.list, zProfileId, ({ profileId }) => storiesRepo.list(profileId));

  // Extract grounded STAR stories from the profile's parsed résumé, atomically
  // replace the existing bank, and (re)index them as `story` chunks for live grounding.
  handle(IPC.stories.generate, zProfileId, async ({ profileId }) => {
    const profile = profilesRepo.get(profileId);
    if (!profile) throw new Error('Profile not found.');
    // Runs on the parsing task's provider (any chat key), not only OpenAI.
    if (!chatTaskReady('parsing')) throw new Error(chatTaskProblem('parsing', 'generate stories'));
    if (!profile.parsedResume)
      throw new Error('This profile needs a parsed résumé first — add & parse one on the profile.');

    const drafts = await generateStories({
      targetRole: profile.targetRole,
      resume: profile.parsedResume,
      resumeText: profile.resumeText,
    });
    // Don't destroy the existing bank for an empty/degenerate extraction.
    if (drafts.length === 0)
      throw new Error(
        'No usable stories could be extracted from this résumé — your existing stories were kept.',
      );
    // Embeds first, then replaces rows + chunks + embeddings atomically, so a
    // failed embedding leaves the prior bank intact.
    return replaceStories(profileId, drafts);
  });

  handle(
    IPC.stories.update,
    z.object({ id: z.string().min(1), patch: storyPatch }),
    async ({ id, patch }) => {
      const existing = storiesRepo.get(id);
      if (!existing) throw new Error('Story not found.');
      const story = storiesRepo.update(id, patch);
      // Re-embed so live retrieval reflects the edited text.
      await indexStories(existing.profileId);
      return story;
    },
  );

  handle(IPC.stories.delete, zId, async ({ id }) => {
    const existing = storiesRepo.get(id);
    if (existing) {
      storiesRepo.delete(id);
      await indexStories(existing.profileId);
    }
    return { deleted: true as const };
  });
}
