import type { ContributionKind } from '@shared/types';

/**
 * A trigger policy answers ONE question: should the engine contribute in
 * response to this text, and as what kind of contribution? Policies are pure
 * decision-makers — they never generate, persist, or broadcast. Deterministic
 * gates (confidence floors here; cooldowns/presence/budget with the ambient
 * modes) always wrap whatever an LLM classifier returns: the model may score,
 * but code decides.
 */
export interface TriggerDecision {
  act: boolean;
  kind: ContributionKind | null;
  /** Classifier output persisted onto the detected-question row (interview). */
  question?: { type: string; confidence: number; strategy: string };
  /** Why (for logs/tests) — e.g. 'not-a-question', 'confidence-below-floor'. */
  reason: string;
}

export interface TriggerPolicy {
  evaluate(text: string): Promise<TriggerDecision>;
}
