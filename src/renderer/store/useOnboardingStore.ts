import { create } from 'zustand';
import type { OnboardingStep } from '../dashboard/onboarding/onboardingFlow';

/**
 * Whether the first-run overlay is showing, and on which step. App opens it
 * from the entry rule (`onboardingEntry`) and Home's "Resume setup" reopens
 * it at Transcription; the overlay itself walks the steps and closes.
 */
interface OnboardingState {
  open: boolean;
  step: OnboardingStep;
  openAt: (step: OnboardingStep) => void;
  setStep: (step: OnboardingStep) => void;
  close: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  open: false,
  step: 'name',
  openAt: (step) => set({ open: true, step }),
  setStep: (step) => set({ step }),
  close: () => set({ open: false }),
}));
