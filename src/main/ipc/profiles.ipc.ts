import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { profilesRepo } from '../db/repositories/profiles.repo';

const interviewType = z.enum([
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'product',
  'sales',
  'general',
]);
// Accept legacy length values ('concise'/'detailed') on the wire and fold them
// into the format axis, so old clients/profiles don't fail validation.
const answerStyle = z
  .enum(['default', 'star', 'technical', 'conversational', 'concise', 'detailed'])
  .transform((v) => (v === 'concise' || v === 'detailed' ? 'default' : v));

const profileInput = z.object({
  name: z.string().min(1),
  targetRole: z.string().default(''),
  targetCompany: z.string().nullable().default(null),
  // Interview type & answer style are chosen per run now; kept optional/legacy.
  interviewType: interviewType.default('general'),
  answerStyle: answerStyle.default('default'),
  language: z.string().default('en'),
  resumeText: z.string().nullable().default(null),
  jdText: z.string().nullable().default(null),
});

export function registerProfilesIpc(): void {
  handle(IPC.profiles.list, z.void(), () => profilesRepo.list());

  handle(IPC.profiles.get, zId, ({ id }) => {
    const p = profilesRepo.get(id);
    if (!p) throw new Error('Profile not found');
    return p;
  });

  handle(IPC.profiles.create, profileInput, (input) => profilesRepo.create(input));

  handle(
    IPC.profiles.update,
    z.object({ id: z.string().min(1), patch: profileInput.partial() }),
    ({ id, patch }) => profilesRepo.update(id, patch),
  );

  handle(IPC.profiles.delete, zId, ({ id }) => {
    profilesRepo.delete(id);
    return { deleted: true as const };
  });

  handle(IPC.profiles.duplicate, zId, ({ id }) => {
    const src = profilesRepo.get(id);
    if (!src) throw new Error('Profile not found');
    return profilesRepo.create({
      name: `${src.name} (copy)`,
      targetRole: src.targetRole,
      targetCompany: src.targetCompany,
      interviewType: src.interviewType,
      answerStyle: src.answerStyle,
      language: src.language,
      resumeText: src.resumeText,
      jdText: src.jdText,
    });
  });
}
