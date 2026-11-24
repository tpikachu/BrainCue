import type { ContributionKind } from '@shared/types';
import type { ClassifierTurn } from '../../openai/questions';
import type { Detection } from '../interview/detector';

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
  /** The interview detector's full verdict (source, continuation) when the
   *  policy used it — the scheduler reads it; other callers can ignore it. */
  detection?: Detection;
}

/** What a policy may know beyond the utterance: the last few turns, so a
 *  short follow-up is judged against what came before it. */
export interface TriggerContext {
  recent?: ClassifierTurn[];
}

export interface TriggerPolicy {
  evaluate(text: string, ctx?: TriggerContext): Promise<TriggerDecision>;
}
