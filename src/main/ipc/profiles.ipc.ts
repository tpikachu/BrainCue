import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle, zId } from './helpers';
import { zInterviewType } from './schemas';
import { profilesRepo } from '../db/repositories/profiles.repo';

const interviewType = zInterviewType;
const profileInput = z.object({
  name: z.string().min(1),
  targetRole: z.string().default(''),
  targetCompany: z.string().nullable().default(null),
  // Interview type is chosen per run now; kept optional/legacy on the profile.
  interviewType: interviewType.default('general'),
  language: z.string().default('en'),
  resumeText: z.string().nullable().default(null),
  jdText: z.string().nullable().default(null),
  // Who they are now (ProfileAbout). Every section is optional — a half-filled
  // profile grounds far better than a blank one, so nothing here is required.
  about: z
    .object({
      role: z.string().max(2000).default(''),
      org: z.string().max(2000).default(''),
      location: z.string().max(2000).default(''),
      workingStyle: z.string().max(4000).default(''),
      people: z.string().max(4000).default(''),
      projects: z.string().max(4000).default(''),
      other: z.string().max(4000).default(''),
    })
    .nullable()
    .default(null),
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
      language: src.language,
      resumeText: src.resumeText,
      jdText: src.jdText,
      about: src.about,
    });
  });
}
