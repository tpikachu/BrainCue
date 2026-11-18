import { describe, expect, it } from 'vitest';
import { assessUtterance, isContinuation, isCorrection } from './questionHeuristics';

const verdict = (t: string) => assessUtterance(t).verdict;

describe('assessUtterance — interview requests without a question mark', () => {
  it.each([
    'Tell me about yourself.',
    'Walk me through that project.',
    'Explain the trade-offs.',
    'So, describe a time you disagreed with your manager.',
    'Okay, now talk me through how you would scale it.',
    'Could you walk me through your resume',
    "I'd love to hear about the migration.",
    "I'm curious how you handled the rollout.",
    'Help me understand why you chose Postgres.',
    "Let's talk about your time at Stripe.",
    'Why that approach',
    'What was your role there',
    'How would you test this',
  ])('%s → question', (t) => {
    expect(verdict(t)).toBe('question');
  });

  it.each(['And your role?', 'Why that approach?', 'Is that right?', 'The second one?'])('%s → question', (t) => {
    expect(verdict(t)).toBe('question');
  });
});

describe('assessUtterance — never a cue', () => {
  it.each(['Okay.', 'Great, thanks!', 'Mm-hmm.', 'Yeah, that makes sense.', 'Got it.', 'Perfect.', 'Thank you so much'])(
    '%s → not',
    (t) => {
      expect(verdict(t)).toBe('not');
    },
  );

  it('courtesy replies to the candidate are not requests', () => {
    expect(verdict("That's a great example, thanks for sharing.")).toBe('not');
  });

  it('stalls are not requests', () => {
    expect(verdict('Take your time.')).toBe('not');
    expect(verdict('Go ahead.')).not.toBe('question');
  });
});

describe('assessUtterance — fragments and ambiguity', () => {
  it('an utterance that stops mid-thought is a fragment', () => {
    expect(verdict('So walk me through the')).toBe('fragment');
    expect(verdict('Tell me about your experience with')).toBe('fragment');
    expect(verdict('I wanted to ask about...')).toBe('fragment');
  });

  it('a finished declarative goes to the classifier', () => {
    expect(verdict('We are building a payments platform with a team of ten.')).toBe('ambiguous');
  });

  it('a wh-clause used as a subject is not taken as a question', () => {
    expect(verdict('What we do here is mostly backend work.')).toBe('ambiguous');
  });

  it('short elliptical turns lean question for the fallback', () => {
    const a = assessUtterance('And your role');
    expect(a.verdict).toBe('ambiguous');
    expect(a.leaning).toBe(true);
  });
});

describe('assessUtterance — type guesses', () => {
  it('behavioral prompts get the behavioral type (story shape)', () => {
    expect(assessUtterance('Tell me about a time you failed.').type).toBe('behavioral');
  });
  it('tell me about yourself is a resume question', () => {
    expect(assessUtterance('Tell me about yourself.').type).toBe('resume_project');
  });
  it('design prompts are system design', () => {
    expect(assessUtterance('How would you design a URL shortener?').type).toBe('system_design');
  });
  it('coding prompts are coding', () => {
    expect(assessUtterance('Write a function that reverses a linked list.').type).toBe('coding');
  });
});

describe('isCorrection / isContinuation', () => {
  it('detects corrections', () => {
    expect(isCorrection('Sorry, I meant the second project.')).toBe(true);
    expect(isCorrection('Actually, let me rephrase that.')).toBe(true);
    expect(isCorrection('Tell me about it.')).toBe(false);
  });
  it('detects continuations of a split question', () => {
    expect(isContinuation('and how you tested it.')).toBe(true);
    expect(isContinuation('And also the rollout plan?')).toBe(true);
    expect(isContinuation('Tell me about your team.')).toBe(false);
    expect(isContinuation('I think so.')).toBe(false);
  });
});

describe('found in the live audio run (2026-11-17)', () => {
  it('a courtesy preamble does not hide the ask that follows it', () => {
    expect(verdict('Thanks for joining. To start, tell me about yourself.')).toBe('question');
    expect(verdict('Great, thanks. So, walk me through your last project.')).toBe('question');
    expect(verdict('Okay, thanks.')).toBe('not');
    expect(verdict('Thanks for walking me through that.')).toBe('not');
  });

  it('call logistics are never a correction or a continuation of the last question', () => {
    expect(isCorrection('Sorry, can you hear me okay? I think my audio cut out.')).toBe(false);
    expect(isContinuation('And can you hear me okay?')).toBe(false);
    expect(isCorrection('Sorry, I meant the second project.')).toBe(true);
  });

  it('a conjunction + complete inverted question is a NEW question, not the second half of the last', () => {
    expect(isContinuation('And why are you interested in this role at Google?')).toBe(false);
    expect(isContinuation('And do you have experience with Kafka?')).toBe(false);
    expect(isContinuation('And what you would do differently.')).toBe(true);
    expect(isContinuation('and how you tested it')).toBe(true);
  });

  it('M3 review: the complete-question guard applies whatever the capitalisation', () => {
    expect(isContinuation('and why are you interested in this role at Google?')).toBe(false);
    expect(isContinuation('AND why are you interested in this role at Google?')).toBe(false);
    expect(isContinuation('and do you have experience with Kafka?')).toBe(false);
    expect(isContinuation('why are you interested in this role?')).toBe(false); // lower-case, no conjunction
    // genuine continuations still continue
    expect(isContinuation('and how you tested it.')).toBe(true);
    expect(isContinuation('and what you would do differently')).toBe(true);
    expect(isContinuation('or the second one.')).toBe(true);
    expect(isContinuation('the rollout plan as well.')).toBe(true);
  });
});
