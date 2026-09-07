import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  canAdvance,
  canSkip,
  nextStep,
  onboardingEntry,
  prevStep,
  shouldAutoStartTour,
} from './onboardingFlow';

const settings = (over: Partial<{ onboardingDone: boolean; sttReady: boolean; apiKeyPresent: boolean }> = {}) => ({
  onboardingDone: false,
  sttReady: false,
  apiKeyPresent: false,
  ...over,
});

describe('onboardingEntry — when the first-run flow opens, and where', () => {
  it('waits until both settings and the profile list have loaded', () => {
    expect(onboardingEntry({ profilesLoaded: false, profileCount: 0, settings: settings() })).toEqual({ kind: 'wait' });
    expect(onboardingEntry({ profilesLoaded: true, profileCount: 0, settings: null })).toEqual({ kind: 'wait' });
  });

  it('fresh install: no profiles → the full flow from the name', () => {
    expect(onboardingEntry({ profilesLoaded: true, profileCount: 0, settings: settings() })).toEqual({
      kind: 'open',
      step: 'name',
    });
  });

  it('asks for a name again after a wipe, even though onboarding was once done', () => {
    // Danger zone deletes every profile but keeps preferences. An app with
    // nobody in it cannot show anything, whatever the flag says.
    expect(
      onboardingEntry({ profilesLoaded: true, profileCount: 0, settings: settings({ onboardingDone: true }) }),
    ).toEqual({ kind: 'open', step: 'name' });
  });

  it('never shows once done, when a profile exists', () => {
    expect(
      onboardingEntry({ profilesLoaded: true, profileCount: 2, settings: settings({ onboardingDone: true }) }),
    ).toEqual({ kind: 'none' });
    // …regardless of how set up they are: the Home checklist handles that.
    expect(
      onboardingEntry({
        profilesLoaded: true,
        profileCount: 1,
        settings: settings({ onboardingDone: true, sttReady: false, apiKeyPresent: false }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('upgrading install that is already set up: marks done silently', () => {
    expect(
      onboardingEntry({
        profilesLoaded: true,
        profileCount: 1,
        settings: settings({ sttReady: true, apiKeyPresent: true }),
      }),
    ).toEqual({ kind: 'mark-done' });
  });

  it('upgrading install missing either piece: opens at Transcription, skipping the name', () => {
    expect(
      onboardingEntry({ profilesLoaded: true, profileCount: 1, settings: settings({ apiKeyPresent: true }) }),
    ).toEqual({ kind: 'open', step: 'transcription' });
    expect(
      onboardingEntry({ profilesLoaded: true, profileCount: 1, settings: settings({ sttReady: true }) }),
    ).toEqual({ kind: 'open', step: 'transcription' });
    expect(onboardingEntry({ profilesLoaded: true, profileCount: 3, settings: settings() })).toEqual({
      kind: 'open',
      step: 'transcription',
    });
  });
});

describe('the step order', () => {
  it('is name → transcription → ai → done, and every step has a rail label', () => {
    expect(ONBOARDING_STEPS).toEqual(['name', 'transcription', 'ai', 'done']);
    for (const s of ONBOARDING_STEPS) expect(STEP_LABELS[s].length).toBeGreaterThan(3);
  });

  it('steps forward and back, clamped at the ends', () => {
    expect(nextStep('name')).toBe('transcription');
    expect(nextStep('transcription')).toBe('ai');
    expect(nextStep('ai')).toBe('done');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('done')).toBe('ai');
    expect(prevStep('name')).toBe('name');
  });

  it('"Later" exists only on the two optional questions', () => {
    // The name is required — nothing works without a profile — and the
    // summary is the exit, not a question. Later on transcription / AI just
    // advances; the Home checklist is the reminder.
    expect(canSkip('name')).toBe(false);
    expect(canSkip('transcription')).toBe(true);
    expect(canSkip('ai')).toBe(true);
    expect(canSkip('done')).toBe(false);
  });

  it('the name step only advances once a profile exists', () => {
    expect(canAdvance('name', { profileCount: 0 })).toBe(false);
    expect(canAdvance('name', { profileCount: 1 })).toBe(true);
    // Sample data counts: it creates a profile too.
    expect(canAdvance('transcription', { profileCount: 1 })).toBe(true);
    expect(canAdvance('ai', { profileCount: 1 })).toBe(true);
  });
});

describe('shouldAutoStartTour — the tour waits its turn', () => {
  const base = { settings: { onboardingDone: true, tourDone: false }, profileCount: 1, onboardingOpen: false };

  it('starts once onboarding is done, a profile exists, and the overlay is closed', () => {
    expect(shouldAutoStartTour(base)).toBe(true);
  });

  it('never starts underneath the onboarding overlay (the original bug)', () => {
    expect(shouldAutoStartTour({ ...base, onboardingOpen: true })).toBe(false);
  });

  it('waits for onboarding, for a profile, and does not replay a finished tour', () => {
    expect(shouldAutoStartTour({ ...base, settings: { onboardingDone: false, tourDone: false } })).toBe(false);
    expect(shouldAutoStartTour({ ...base, profileCount: 0 })).toBe(false);
    expect(shouldAutoStartTour({ ...base, settings: { onboardingDone: true, tourDone: true } })).toBe(false);
    expect(shouldAutoStartTour({ ...base, settings: null })).toBe(false);
  });
});
