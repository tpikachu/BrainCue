import { describe, expect, it, vi } from 'vitest';
import { ConversationContext, LIMITS, leadOf } from './conversationContext';
import { buildConversationBlock } from '../../openai/answer';

// answer.ts reaches the provider registry (and through it the db); only its
// pure renderer is used here.
vi.mock('../../../providers/registry', () => ({ providerFor: () => ({}) }));

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

describe('long spoken answers keep their details (review finding: 600-char clip at storage)', () => {
  // ~1,060 characters; the project name and the downtime figure come LAST,
  // the way people actually tell a story.
  const LONG =
    'So when I joined, the platform team was mostly firefighting, and the first thing I did was sit with each of the on-call engineers for a week to understand where the pages were coming from. ' +
    'A lot of it was noise, alerts that fired on symptoms nobody could act on, so we spent the first month rewriting the alerting rules and deleting about a third of them. ' +
    'That bought us room to look at the real problem, which was the way deployments touched the shared database during business hours. ' +
    'We put together a working group with the product teams, agreed on a freeze window, and wrote down a runbook that everyone could follow without me in the room. ' +
    'Then we did the dry runs, three of them, each one on a copy of production, and each one found something we would have missed. ' +
    'I also made sure support knew exactly what customers would see during the window, so nobody was surprised. ' +
    'By the time we did it for real I was fairly confident, and it went well. ' +
    'That was the Atlas cut-over, and we finished it with 40 minutes of downtime instead of the six hours the old process needed.';

  it('the fixture really is long', () => {
    expect(LONG.length).toBeGreaterThan(1000);
  });

  it('the next follow-up sees the project name and the figure', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about a migration you led.', LONG);
    const q = 'How did you measure that?';
    c.addTurn('interviewer', q, at());
    const snap = c.snapshot(q);
    const rendered = JSON.stringify(snap);
    expect(rendered).toContain('Atlas cut-over');
    expect(rendered).toContain('40 minutes of downtime');
    expect(snap.subject?.said).toContain('40 minutes');
    expect(c.retrievalQuery(q)).toContain('Atlas');
  });

  it('a turn longer than its prompt budget keeps the first sentence and the details', () => {
    const c = new ConversationContext();
    const longer = `${LONG} ${LONG.replace('Atlas', 'Borealis').replace('40 minutes', '25 minutes')}`;
    exchange(c, 'Tell me about a migration you led.', longer);
    const q = 'What was the downtime?';
    const snap = c.snapshot(q);
    const said = snap.recent.find((t) => t.role === 'candidate')!.text;
    expect(said.length).toBeLessThanOrEqual(LIMITS.turnChars + 20);
    expect(said.startsWith('So when I joined')).toBe(true);
    expect(said).toMatch(/downtime/);
    expect(said).toContain('…');
  });

  it('recall searches the whole of an old long answer, many exchanges later', () => {
    const c = new ConversationContext();
    exchange(c, 'Tell me about a migration you led.', LONG);
    for (let i = 1; i <= 30; i++) exchange(c, `Question number ${i} about topic ${i}?`, `Answer ${i} about topic ${i}.`);
    const q = 'Coming back to the Atlas cut-over — what would you change?';
    const snap = c.snapshot(q);
    const recalled = snap.recalled.map((t) => t.text).join(' ');
    expect(recalled).toContain('Atlas cut-over');
    expect(recalled).toContain('40 minutes');
    expect(recalled.length).toBeLessThanOrEqual(LIMITS.recalledChars * LIMITS.recalledTurns + 60);
  });
});

describe('M4: whole turns in memory; the persisted transcript past the bound; bounded rendering', () => {
  const FACT_TURN = 'That was the Atlas cut-over, and we finished it with 40 minutes of downtime instead of six hours.';

  it('stores a long turn WHOLE — the 600-character clip at storage is gone', () => {
    const c = new ConversationContext();
    const long = `${'We spent weeks on the alerting rules and the runbook. '.repeat(90)}${FACT_TURN}`;
    c.addTurn('candidate', long, at());
    expect(c.recentForClassifier(1)[0].text.length).toBeLessThanOrEqual(LIMITS.classifierTurnChars + 20); // rendered: bounded
    const snap = c.snapshot('What was the downtime on the Atlas cut-over?');
    expect(JSON.stringify(snap)).toContain('40 minutes of downtime'); // stored: whole, so the end survives
  });

  it('past the in-memory bound, recall searches the persisted transcript — loaded once per eviction', () => {
    let loads = 0;
    const persisted: { role: 'interviewer' | 'candidate'; text: string; at: number }[] = [];
    const c = new ConversationContext(() => {
      loads++;
      return persisted;
    });
    const add = (role: 'interviewer' | 'candidate', text: string) => {
      const t = at();
      persisted.push({ role, text, at: t });
      c.addTurn(role, text, t);
    };
    add('interviewer', 'Tell me about a migration you led.');
    add('candidate', FACT_TURN);
    for (let i = 0; i < LIMITS.maxTurns; i++) add(i % 2 ? 'candidate' : 'interviewer', `Filler turn ${i} about caching.`);
    expect(c.size).toBe(LIMITS.maxTurns); // memory is bounded
    const q = 'Coming back to the Atlas cut-over — what was the downtime?';
    const snap = c.snapshot(q);
    expect(snap.recalled.map((t) => t.text).join(' ')).toContain('40 minutes of downtime');
    c.snapshot(q);
    expect(loads).toBe(1); // memoized until more turns are evicted
  });

  it('without a persisted source, an evicted turn is simply out of reach (memory is the bound)', () => {
    const c = new ConversationContext();
    c.addTurn('candidate', FACT_TURN, at());
    for (let i = 0; i < LIMITS.maxTurns; i++) c.addTurn('interviewer', `Filler turn ${i}.`, at());
    expect(JSON.stringify(c.snapshot('What was the Atlas downtime?'))).not.toContain('40 minutes');
  });

  it('the rendered conversation block has a hard ceiling, however long the session and its turns', () => {
    const c = new ConversationContext();
    const huge = 'We measured everything twice and wrote it all down for the team. '.repeat(120);
    for (let i = 0; i < 60; i++) exchange(c, `${'Tell me, in detail, about project number '.repeat(8)}${i}?`, huge, `**${'Long suggested lead. '.repeat(40)}**`);
    const q = 'And what did you learn from it?';
    c.addTurn('interviewer', q, at());
    const block = buildConversationBlock(c.snapshot(q));
    const ceiling =
      LIMITS.recentChars + LIMITS.turnChars +
      LIMITS.earlierExchanges * (LIMITS.earlierQuestionChars + LIMITS.earlierSaidChars + 40) +
      LIMITS.recalledTurns * (LIMITS.recalledChars + 40) +
      LIMITS.suggestions * (LIMITS.earlierQuestionChars + LIMITS.suggestionChars + 20) +
      LIMITS.earlierQuestionChars + LIMITS.subjectSaidChars + 200 +
      3 * (LIMITS.earlierQuestionChars + 20) + 600;
    expect(block.length).toBeLessThanOrEqual(ceiling);
    expect(ceiling).toBeLessThan(16_000);
  });
});
