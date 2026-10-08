import { z } from 'zod';
import { normalizeAnswerFormat } from '@shared/types';

/**
 * Shared zod enums for IPC inputs — the single source of truth. These were
 * previously duplicated inline across session/mock/sparring/profiles .ipc.ts,
 * which is exactly how enum drift happens (the v2 audit caught `story_teller`
 * missing from docs because of it). Keep these in lockstep with the domain
 * types in @shared/types.
 */

export const zInterviewType = z.enum([
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'general',
]);

/** The two live answer styles. The five legacy formats are still ACCEPTED (a
 *  stored pref or an older caller may send them) and mapped: key_points /
 *  explanation / story_teller / star → 'general', detailed → 'technical'. */
export const zAnswerFormat = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeAnswerFormat(v) : v),
  z.enum(['general', 'technical']),
);

export const zTtsVoice = z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);

// v2 vocabulary — consumed by engine/pack IPC as those phases land.
export const zSessionMode = z.enum([
  'interview',
  'practice',
  'interviewer_assist',
  'meeting',
  'tutor',
  'companion',
]);

export const zPresence = z.enum(['summoned', 'quiet', 'balanced', 'active']);

export const zContextPackKind = z.enum([
  'job',
  'subject',
  'project',
  'meeting',
  'personal',
  'game',
  'custom',
]);
