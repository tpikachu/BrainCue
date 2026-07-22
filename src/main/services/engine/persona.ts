import type {
  CompanionPersonality,
  CompanionPrefs,
  CompanionSpaceOverrides,
} from '@shared/types';

/**
 * The ONE place personality text is built (the prompt's "do not duplicate
 * personality prompts across every mode" rule). Modes that speak with the
 * companion's voice request a preamble here; per-Space overrides merge over
 * the global config before rendering.
 */

export const DEFAULT_COMPANION_PREFS: CompanionPrefs = {
  personality: { name: 'BrainCue', voice: null, tone: 'warm', brevity: 'normal', humor: false },
  presence: 'assistive',
  dnd: [],
  budgetCents: null,
};

/** Per-Space overrides win field-by-field; absent fields inherit. */
export function mergePersonality(
  global: CompanionPersonality,
  overrides: CompanionSpaceOverrides | null | undefined,
): CompanionPersonality {
  if (!overrides) return global;
  return {
    ...global,
    ...(overrides.tone !== undefined ? { tone: overrides.tone } : {}),
    ...(overrides.brevity !== undefined ? { brevity: overrides.brevity } : {}),
    ...(overrides.humor !== undefined ? { humor: overrides.humor } : {}),
  };
}

const TONE_LINE: Record<CompanionPersonality['tone'], string> = {
  warm: 'Warm and encouraging — a friendly colleague, never saccharine.',
  neutral: 'Even and matter-of-fact.',
  direct: 'Direct and to the point — skip the pleasantries.',
};

const BREVITY_LINE: Record<CompanionPersonality['brevity'], string> = {
  terse: 'Answer in one or two sentences whenever possible.',
  normal: 'Keep replies brief — a few sentences unless more is truly needed.',
  chatty: 'Conversational length is fine, but never ramble.',
};

/** Render the personality as a system-prompt fragment. Deterministic —
 *  identical config always renders identical text (prompt-cache friendly). */
export function buildPersonaPreamble(p: CompanionPersonality): string {
  return [
    `Your name is ${p.name}.`,
    TONE_LINE[p.tone],
    BREVITY_LINE[p.brevity],
    p.humor
      ? 'Light humor is welcome when it fits; never at the expense of clarity.'
      : 'Stay straightforward — no jokes.',
  ].join(' ');
}
