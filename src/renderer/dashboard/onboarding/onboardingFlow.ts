/**
 * First-run setup — the step logic, kept pure so it can be tested without a
 * DOM (docs/11-UX-NAVIGATION.md "First run").
 *
 * Three questions in order, then a summary: who this is for (a profile — the
 * one thing nothing works without), how BrainCue hears the room (cloud or an
 * on-device model), and which AI it thinks with (the OpenAI key, optional
 * extras). Only the name is required; the other two can be answered "Later"
 * and the Home checklist keeps asking until they are.
 *
 * The guided tour used to auto-start on first launch at the same moment the
 * non-dismissable "Welcome" dialog asked for a name — and rendered underneath
 * it, unusable. The tour now waits until this flow is finished (App.tsx reads
 * `onboardingDone` before starting it), and the Done screen is what offers it.
 */

export const ONBOARDING_STEPS = ['name', 'transcription', 'ai', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Rail labels — numbered for the three questions, plain for the summary. */
export const STEP_LABELS: Record<OnboardingStep, string> = {
  name: '1 · Your name',
  transcription: '2 · Transcription',
  ai: '3 · AI configuration',
  done: 'Done',
};

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = stepIndex(step);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)];
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  const i = stepIndex(step);
  return ONBOARDING_STEPS[Math.max(i - 1, 0)];
}

/** Steps that may be skipped with "Later". The name cannot: an app with no
 *  profile has nothing to show. The summary is the exit, not a question. */
export function canSkip(step: OnboardingStep): boolean {
  return step === 'transcription' || step === 'ai';
}

/** Whether "Continue" is allowed on a step. Only the name step gates — it
 *  advances once a profile exists, however it was created (typed, or sample
 *  data). The other steps advance regardless: "Later" and "Continue" differ
 *  only in what the user did before pressing them. */
export function canAdvance(step: OnboardingStep, s: { profileCount: number }): boolean {
  if (step === 'name') return s.profileCount > 0;
  return true;
}

export interface OnboardingInputs {
  /** False until the profile list has been read once — nothing is decided on
   *  an empty list that is merely still loading. */
  profilesLoaded: boolean;
  profileCount: number;
  /** null until settings have loaded. */
  settings: { onboardingDone: boolean; sttReady: boolean; apiKeyPresent: boolean } | null;
}

export type OnboardingEntry =
  | { kind: 'wait' }
  | { kind: 'none' }
  /** An install that predates onboarding and is already fully set up: record
   *  that silently rather than walking a working user through questions they
   *  have answered. */
  | { kind: 'mark-done' }
  | { kind: 'open'; step: OnboardingStep };

/**
 * What to do when the shell has loaded settings and profiles.
 *
 *  - No profiles → the full flow from the name. This is what a fresh install
 *    looks like, and also what a Danger-zone wipe leaves behind (the wipe
 *    deletes profiles but keeps preferences, `onboardingDone` included) — an
 *    app with nobody in it must ask again whatever the flag says.
 *  - Profiles exist and onboarding was finished or skipped → nothing.
 *  - Profiles exist, onboarding never ran (an upgrade): if transcription and
 *    the OpenAI key are both ready, mark it done without a word; otherwise
 *    open at the transcription step — they have a name, they do not have the
 *    two new questions.
 */
export function onboardingEntry(i: OnboardingInputs): OnboardingEntry {
  if (!i.profilesLoaded || !i.settings) return { kind: 'wait' };
  if (i.profileCount === 0) return { kind: 'open', step: 'name' };
  if (i.settings.onboardingDone) return { kind: 'none' };
  if (i.settings.sttReady && i.settings.apiKeyPresent) return { kind: 'mark-done' };
  return { kind: 'open', step: 'transcription' };
}

/**
 * The tour's turn. It waits for onboarding to be over (`onboardingDone`),
 * for a profile to exist (its steps point at profile-scoped surfaces), and
 * for the onboarding overlay to be closed — the bug this replaces was the
 * tour launching underneath the first-run dialog.
 */
export function shouldAutoStartTour(a: {
  settings: { onboardingDone: boolean; tourDone: boolean } | null;
  profileCount: number;
  onboardingOpen: boolean;
}): boolean {
  if (!a.settings) return false;
  if (a.onboardingOpen) return false;
  if (a.profileCount === 0) return false;
  return a.settings.onboardingDone && !a.settings.tourDone;
}
