import { describe, expect, it } from 'vitest';
import { ConversationContext, LIMITS, leadOf } from './conversationContext';

let clock = 1_000_000;
const at = () => (clock += 1000);

/** One interview exchange: the interviewer asks, BrainCue suggests, the
 *  candidate says what they actually said. */
function exchange(c: ConversationContext, q: string, said: string, suggestion = `**Suggested answer to: ${q}**`) {
  c.addTurn('interviewer', q, at());
  c.addSuggestion(`q-${q}`, q, suggestion, at());
  if (said) c.addTurn('candidate', said, at());
}

describe('follow-ups stay on the right subject', () => {
  it('"What was your role there?" resolves to the LAST project discussed, not an earlier one', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about the payments migration at Stripe.', 'We moved the ledger to Postgres over six months.');
    exchange(c, 'Now walk me through the search project at Northwind.', 'I rebuilt the ranking pipeline with learning to rank.');
    const q = 'What was your role there?';
    c.addTurn('interviewer', q, at());
    const snap = c.snapshot(q);
    expect(snap.subject?.question).toBe('Now walk me through the search project at Northwind.');
    expect(c.retrievalQuery(q)).toContain('ranking pipeline');
    expect(c.retrievalQuery(q)).not.toContain('Stripe');
  });

  it('retrieval follows what the candidate SAID, not what BrainCue suggested', () => {
    const c = new ConversationContext();
    exchange(
      c,
      'Tell me about a migration you led.',
      'The big one was moving our billing database to Postgres.',
      '**I led the Kafka event-bus migration at Acme.** [1]', // the cue named a different project
    );
    const q = 'Why that one?';
    const query = c.retrievalQuery(q);
    expect(query).toContain('billing database to Postgres');
    expect(query).not.toContain('Kafka');
    const snap = c.snapshot(q);
    // Both are present — in different, labelled places.
    expect(snap.subject?.said).toContain('Postgres');
    expect(snap.suggestions[0].lead).toContain('Kafka');
  });

  it('with no candidate speech captured, the suggestion lead is the only subject signal', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about a migration you led.', '', '**I led the Kafka migration at Acme.**');
    expect(c.retrievalQuery('And your role?')).toContain('Kafka migration');
  });

  it('a topic switch is not attached to the previous topic', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about the payments migration.', 'We moved the ledger to Postgres.');
    for (const q of ['And what about Kubernetes?', "Let's move on. How do you handle conflict?", 'Tell me about your experience leading a team of engineers across two continents.']) {
      expect(c.snapshot(q).subject).toBeNull();
      expect(c.retrievalQuery(q)).toBe(q);
    }
  });

  it('short anaphoric follow-ups are referential', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about the payments migration.', 'We moved the ledger to Postgres.');
    for (const q of ['Why that approach?', 'How long did it take?', 'And the outcome?', 'What was your role there?']) {
      expect(c.snapshot(q).subject).not.toBeNull();
    }
  });
});

describe('earlier context survives a long interview, bounded', () => {
  it('a candidate statement from exchange 3 is still usable after 35 exchanges', () => {
    const c = new ConversationContext();
    for (let i = 1; i <= 35; i++) {
      exchange(
        c,
        `Question number ${i} about topic ${i}?`,
        i === 3 ? 'At Acme I was the on-call lead for the checkout service for two years.' : `Answer ${i} about topic ${i}.`,
      );
    }
    const q = 'Tell me more about being on-call for checkout.';
    const snap = c.snapshot(q);
    const everything = JSON.stringify(snap);
    expect(everything).toContain('on-call lead for the checkout service');
    // It is recalled (or in the compact record), not because the window is huge:
    expect(snap.recent.length).toBeLessThanOrEqual(LIMITS.recentTurns);
    expect(snap.earlier.length).toBeLessThanOrEqual(LIMITS.earlierExchanges);
  });

  it('the snapshot stays bounded however long the interview gets', () => {
    const c = new ConversationContext();
    for (let i = 0; i < 1500; i++) exchange(c, `Long question ${i} ${'x'.repeat(200)}?`, `Long answer ${i} ${'y'.repeat(500)}.`);
    const chars = JSON.stringify(c.snapshot('Anything else?')).length;
    expect(chars).toBeLessThan(15_000);
    expect(c.size).toBeLessThanOrEqual(LIMITS.maxTurns);
  });
});

describe('snapshot coherence and ordering', () => {
  it('a snapshot is a copy — turns added during generation do not change it', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about yourself.', 'I am a backend engineer.');
    const snap = c.snapshot('Why this company?');
    const before = JSON.stringify(snap);
    c.addTurn('interviewer', 'Something said mid-stream.', at());
    c.addTurn('candidate', 'And my reply.', at());
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('a late-committed candidate turn is placed by when it was spoken', () => {
    const c = new ConversationContext();
    const tQ1 = at();
    c.addTurn('interviewer', 'Which database did you choose?', tQ1);
    const tReply = at();
    const tQ2 = at();
    c.addTurn('interviewer', 'How did you test the migration?', tQ2);
    c.addTurn('candidate', 'We chose Postgres.', tReply); // committed after Q2 (echo hold)
    const ex = c.exchanges();
    expect(ex[0]).toMatchObject({ question: 'Which database did you choose?', said: 'We chose Postgres.' });
    expect(ex[1]).toMatchObject({ question: 'How did you test the migration?', said: '' });
  });

  it('the question itself is not part of its own context', () => {
    const c = new ConversationContext();
    c.addTurn('interviewer', 'Tell me about yourself.', at());
    expect(c.snapshot('Tell me about yourself.').recent).toEqual([]);
  });

  it('earlier questions the candidate never answered are surfaced as open', () => {
    const c = new ConversationContext();
    c.addTurn('interviewer', 'What is your notice period?', at());
    for (let i = 0; i < 20; i++) exchange(c, `Follow-up ${i}?`, `Reply ${i}.`);
    expect(c.snapshot('Anything else?').open.map((e) => e.question)).toContain('What is your notice period?');
  });
});

describe('resume and isolation', () => {
  it('hydrate restores a session so follow-ups still resolve', () => {
    const c = new ConversationContext();
    c.hydrate(
      [
        { role: 'interviewer', text: 'Tell me about the Northwind search project.', at: 1 },
        { role: 'candidate', text: 'I rebuilt the ranking pipeline.', at: 2 },
      ],
      [{ questionId: 'q1', question: 'Tell me about the Northwind search project.', answer: '**I led ranking.**', at: 1.5 }],
    );
    expect(c.retrievalQuery('What was your role there?')).toContain('ranking pipeline');
  });

  it('two contexts never share state', () => {
    const a = new ConversationContext();
    const b = new ConversationContext();
    exchange(a, 'Tell me about the secret project at Acme.', 'It was the Falcon launch.');
    expect(JSON.stringify(b.snapshot('What was your role there?'))).not.toContain('Falcon');
    expect(b.retrievalQuery('What was your role there?')).toBe('What was your role there?');
  });
});

describe('leadOf', () => {
  it('takes the first sentence, without markdown or citations', () => {
    expect(leadOf('**I led the migration at Acme.** It took six months [1].\n- bullet')).toBe('I led the migration at Acme.');
  });
});
