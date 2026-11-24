import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const h = vi.hoisted(() => ({
  result: { isQuestion: false, type: 'clarification', confidence: 0, strategy: '' },
}));
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../openai/questions', () => ({
  classifyQuestion: async () => {
    calls.n++;
    return h.result;
  },
}));

import { QUESTION_CONFIDENCE_FLOOR, reactiveQuestionPolicy } from './reactiveQuestionPolicy';
import { summonedPolicy } from './summonedPolicy';

describe('reactiveQuestionPolicy (the v1 gate as a policy)', () => {
  it('does not act on a non-question', async () => {
    h.result = { isQuestion: false, type: 'clarification', confidence: 0.95, strategy: '' };
    const d = await reactiveQuestionPolicy.evaluate('Moving on.');
    expect(d).toMatchObject({ act: false, kind: null, reason: 'not-a-question' });
  });

  it('does not act below the confidence floor', async () => {
    h.result = { isQuestion: true, type: 'behavioral', confidence: 0.39, strategy: '' };
    const d = await reactiveQuestionPolicy.evaluate('Hmm?');
    expect(d).toMatchObject({ act: false, reason: 'confidence-below-floor' });
  });

  it('acts exactly AT the floor (>= 0.4, the v1 boundary)', async () => {
    h.result = {
      isQuestion: true,
      type: 'system_design',
      confidence: QUESTION_CONFIDENCE_FLOOR,
      strategy: 'tradeoffs',
    };
    // An utterance no rule decides, so the classifier's score is what counts.
    const d = await reactiveQuestionPolicy.evaluate('And the scaling side');
    expect(d.act).toBe(true);
    expect(d.kind).toBe('answer');
    // Classifier output flows through untouched — it lands on the question row.
    expect(d.question).toEqual({ type: 'system_design', confidence: 0.4, strategy: 'tradeoffs' });
  });
});

describe('reactiveQuestionPolicy — reliable rules skip the model', () => {
  it('an interview request without a question mark acts with no classifier call', async () => {
    calls.n = 0;
    h.result = { isQuestion: false, type: 'clarification', confidence: 0.99, strategy: '' };
    const d = await reactiveQuestionPolicy.evaluate('Tell me about yourself.');
    expect(d.act).toBe(true);
    expect(d.detection?.source).toBe('heuristic');
    expect(calls.n).toBe(0);
  });

  it('backchannel never reaches the classifier', async () => {
    calls.n = 0;
    const d = await reactiveQuestionPolicy.evaluate('Okay, great.');
    expect(d.act).toBe(false);
    expect(calls.n).toBe(0);
  });
});

describe('summonedPolicy (direct ask)', () => {
  it('always acts, with the v1 manual-ask defaults', async () => {
    const d = await summonedPolicy.evaluate('What is your greatest strength?');
    expect(d.act).toBe(true);
    expect(d.kind).toBe('answer');
    expect(d.question).toEqual({ type: 'behavioral', confidence: 1, strategy: '' });
  });
});
