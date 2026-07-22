import { describe, expect, it } from 'vitest';
import { answersQuestion, evaluateTurnHeuristics } from './meetingHeuristics';

describe('skip verdicts — the turns that must never cost a model call', () => {
  it('greetings and small talk', () => {
    for (const t of [
      'Hi everyone, good morning!',
      'How are you all doing?',
      'Can you hear me okay?',
      'Thanks everyone, bye!',
    ]) {
      expect(evaluateTurnHeuristics(t)).toEqual({ type: 'skip', reason: 'greeting' });
    }
    // Ultra-short turns skip before any other rule.
    expect(evaluateTurnHeuristics('Hey there')).toEqual({ type: 'skip', reason: 'too-short' });
  });

  it('pure filler/acknowledgement turns', () => {
    for (const t of ['Okay.', 'yeah', 'Sounds good!', 'mm-hmm', 'Got it']) {
      expect(evaluateTurnHeuristics(t).type).toBe('skip');
    }
  });

  it('a greeting LEAD does not silence a substantive turn', () => {
    const v = evaluateTurnHeuristics(
      'Good morning everyone, we have decided to go with the phased rollout plan.',
    );
    expect(v.type).toBe('decision');
  });
});

describe('confident verdicts', () => {
  it('action item with an explicit deadline gets top confidence + the deadline', () => {
    const v = evaluateTurnHeuristics('I will send the launch checklist by Friday.');
    expect(v).toMatchObject({ type: 'action_item', deadline: 'by Friday' });
    expect((v as { confidence: number }).confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('explicit "action item"/"follow up" markers count without a deadline', () => {
    expect(evaluateTurnHeuristics('Action item: update the pricing deck.').type).toBe(
      'action_item',
    );
    expect(evaluateTurnHeuristics("Let's follow up on the contract question.").type).toBe(
      'action_item',
    );
  });

  it('commitment language WITHOUT a marker or deadline stays ambiguous (not an action item)', () => {
    expect(evaluateTurnHeuristics("Let's think about the architecture some more.").type).toBe(
      'ambiguous',
    );
  });

  it('decisions', () => {
    for (const t of [
      'We have decided to go with the phased rollout.',
      "We've agreed on the new pricing.",
      "Let's go with option B for the launch.",
    ]) {
      expect(evaluateTurnHeuristics(t).type).toBe('decision');
    }
  });

  it('questions', () => {
    const v = evaluateTurnHeuristics('What is our budget for the Q3 campaign?');
    expect(v.type).toBe('question');
  });

  it('plain statements are ambiguous — the classifier decides', () => {
    expect(evaluateTurnHeuristics('The roadmap has three phases planned.').type).toBe('ambiguous');
  });
});

describe('answersQuestion — conservative unanswered-question tracking', () => {
  const q = 'What is our budget for the Q3 campaign?';

  it('shared content words count as an answer', () => {
    expect(answersQuestion('The budget is still being finalized.', q)).toBe(true);
  });

  it('a bare yes/no counts as an answer', () => {
    expect(answersQuestion('Yes.', q)).toBe(true);
  });

  it('an answer-lead with a number counts', () => {
    expect(answersQuestion("It's around 50k.", q)).toBe(true);
  });

  it('a topic change does NOT count — even with a polite lead', () => {
    expect(answersQuestion('Let us move on to the roadmap discussion.', q)).toBe(false);
    expect(answersQuestion('Sure, roadmap first.', q)).toBe(false);
  });
});
