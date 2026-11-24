import { detectQuestion } from '../interview/detector';
import type { TriggerPolicy } from './triggerPolicy';

export { QUESTION_CONFIDENCE_FLOOR } from '../interview/detector';

/**
 * Interview Copilot's trigger: react when the interviewer asks for an answer.
 * Delegates to the interview detector (engine/interview/detector.ts):
 * reliable rules first ("Tell me about yourself." needs no model call), the
 * classifier — with recent context, a timeout, and validated output — for
 * the ambiguous rest, and the v1 0.4 confidence floor on whatever the model
 * says. The model may score, code decides.
 */
export const reactiveQuestionPolicy: TriggerPolicy = {
  async evaluate(text, ctx) {
    const d = await detectQuestion(text, { recent: ctx?.recent });
    if (!d.act) return { act: false, kind: null, reason: d.reason, detection: d };
    return {
      act: true,
      kind: 'answer',
      question: { type: d.type, confidence: d.confidence, strategy: d.strategy },
      reason: d.source === 'model' ? 'question-detected' : d.reason,
      detection: d,
    };
  },
};
