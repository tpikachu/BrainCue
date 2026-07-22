import { classifyQuestion } from '../../openai/questions';
import type { TriggerPolicy } from './triggerPolicy';

/** The v1 gate, unchanged: only classifier-confirmed questions at or above
 *  this confidence get an automatic answer. */
export const QUESTION_CONFIDENCE_FLOOR = 0.4;

/**
 * Interview Copilot's trigger: react when the remote speaker asks a question.
 * Wraps the classifier (an LLM call) in the deterministic confidence floor —
 * exactly the v1 behavior, now expressed as a policy the engine can swap.
 */
export const reactiveQuestionPolicy: TriggerPolicy = {
  async evaluate(text) {
    const c = await classifyQuestion(text);
    if (!c.isQuestion) return { act: false, kind: null, reason: 'not-a-question' };
    if (c.confidence < QUESTION_CONFIDENCE_FLOOR) {
      return { act: false, kind: null, reason: 'confidence-below-floor' };
    }
    return {
      act: true,
      kind: 'answer',
      question: { type: c.type, confidence: c.confidence, strategy: c.strategy },
      reason: 'question-detected',
    };
  },
};
