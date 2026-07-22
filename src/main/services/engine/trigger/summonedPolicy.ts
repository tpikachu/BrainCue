import type { TriggerPolicy } from './triggerPolicy';

/**
 * The user asked directly (Cue Card Ask box / push-to-talk later): always
 * act, no classification round-trip. The question metadata matches v1's
 * manual-ask defaults so persisted rows are unchanged.
 */
export const summonedPolicy: TriggerPolicy = {
  async evaluate() {
    return {
      act: true,
      kind: 'answer' as const,
      question: { type: 'behavioral', confidence: 1, strategy: '' },
      reason: 'summoned',
    };
  },
};
