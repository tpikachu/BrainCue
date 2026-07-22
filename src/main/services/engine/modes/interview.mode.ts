import { streamAnswer } from '../../openai/answer';
import { predictFollowup } from '../../openai/followup';
import { reactiveQuestionPolicy } from '../trigger/reactiveQuestionPolicy';
import type { ModeDefinition } from '../modeDefinition';

/**
 * Interview Copilot as a ModeDefinition — the v1 pipeline's interview-specific
 * choices, now expressed as configuration:
 *  - reacts to classifier-confirmed questions (reactive policy, 0.4 floor)
 *  - persona/prompting lives in streamAnswer (grounded, never inventing)
 *  - keeps the legacy 'interviewer' speaker label so rows + Cue Card match v1
 *  - predicts the interviewer's likely follow-up after each answer
 */
export const interviewMode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask', 'screen', 'clipboard'],
  remoteSpeaker: 'interviewer',
  trigger: reactiveQuestionPolicy,
  allowedContributions: ['answer', 'code'],
  surfaces: ['overlay', 'report'],
  // Interview auto-answers detected questions; the tunable presence dial
  // arrives with the ambient modes.
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',

  generate(input) {
    return streamAnswer({
      question: input.question,
      contextChunks: input.contextChunks,
      profile: input.profile,
      // Answer format + pronunciation are chosen per run (this round) and can
      // be toggled live from the Cue Card.
      format: input.settings.answerFormat,
      pronunciation: input.settings.pronunciation,
      interviewType: input.settings.interviewType,
      signal: input.signal,
    });
  },

  predictFollowup({ question, answer, settings }) {
    return predictFollowup({ question, answer, interviewType: settings.interviewType });
  },
};
