import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M4 — the interview coaching report coaches what the candidate SAID.
 *
 * Before M4 the coach received `Q: <question> / A: <ai_answers.directAnswer>`:
 * the "A" was BrainCue's own suggested answer, so the report graded the cue
 * card; a session where the candidate said nothing still got strengths; and
 * the input was cut at 24,000 characters, dropping every later question.
 * Real persistence (sql.js + migrations); only the model call is scripted.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  calls: [] as { system: string; user: string }[],
  reply: {} as Record<string, unknown>,
  sparring: 0,
}));

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return {
    schema,
    db: () => {
      if (!h.db) throw new Error('test db not initialized');
      return h.db;
    },
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});
vi.mock('../openai/chatTask', () => ({
  chatJson: async (req: { system: string; user: string }) => {
    h.calls.push(req);
    return h.reply;
  },
}));
vi.mock('../mock/sparringManager', () => ({
  buildSparringReport: () => {
    h.sparring++;
    return { id: 'r', sessionId: 's', summary: 'sparring', strengths: [], improvements: [], perQuestion: [], createdAt: 0 };
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { enginePersistence as persist } from '../engine/persistence/enginePersistence';
import { generateReport, NO_ANSWER_CAPTURED } from './report';

const T0 = 1_800_000_000_000;
let seq = 0;

function session(kind = 'live'): string {
  const profileId = `rp${++seq}`;
  h.db.insert(schema.profiles).values({ id: profileId, name: 'R', targetRole: 'Engineer' }).run();
  const id = `rs${seq}`;
  h.db
    .insert(schema.sessions)
    .values({ id, profileId, packId: null, mode: 'interview', kind, interviewType: 'general', status: 'stopped' })
    .run();
  return id;
}
/** An interviewer question (a transcript turn + its question row + BrainCue's suggestion). */
function asked(sid: string, text: string, at: number, suggestion: string | null): string {
  const tc = persist.finalTranscript(sid, 'interviewer', text, at);
  const qid = persist.insertQuestion({ sessionId: sid, text, type: 'behavioral', confidence: 0.9, strategy: '', transcriptChunkId: tc });
  if (suggestion !== null) persist.replaceAnswer({ questionId: qid, directAnswer: suggestion, riskWarning: null, tokens: null });
  return qid;
}
const said = (sid: string, text: string, at: number) => persist.finalTranscript(sid, 'candidate', text, at);

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.calls.length = 0;
  h.reply = {};
  h.sparring = 0;
});

describe('interview coaching assesses captured speech, never the suggestion', () => {
  it('pairs each question with what the candidate said; the suggestion is labelled, a silent question is reported as such', async () => {
    const sid = session();
    asked(sid, 'Tell me about a migration you led.', T0, 'I led the Kafka migration at Acme. It cut lag 40%.');
    said(sid, 'We moved billing from MySQL to Postgres over one quarter.', T0 + 1_000);
    asked(sid, 'Why are you leaving your current role?', T0 + 5_000, 'Suggestion two: growth.');
    asked(sid, 'What is your biggest weakness?', T0 + 9_000, 'Suggestion three: delegation.');
    said(sid, 'Honestly, I take on too much myself instead of delegating.', T0 + 10_000);
    h.reply = {
      summary: 'Clear and specific.',
      strengths: ['Concrete scope'],
      improvements: ['Add a metric'],
      perQuestion: [
        { n: 1, assessment: 'Good scope; add the outcome.' },
        { n: 2, assessment: 'Honest; give an example.' },
      ],
    };
    const report = await generateReport(sid);

    expect(h.calls).toHaveLength(1);
    const user = h.calls[0].user;
    expect(user).toContain('Candidate said: "We moved billing from MySQL to Postgres over one quarter."');
    expect(user).toContain('BrainCue suggested (NOT the candidate\'s answer): "I led the Kafka migration at Acme."');
    expect(user).not.toMatch(/^A: /m); // the old "A: <suggestion>" pairing is gone
    expect(user).not.toMatch(/Candidate said: "[^"]*Kafka/); // the suggestion never becomes their words
    expect(user).toMatch(/NO ANSWER WAS CAPTURED[^\n]*\n- Why are you leaving your current role\?/);
    expect(h.calls[0].system).toMatch(/assess ONLY what the candidate actually SAID/);
    expect(h.calls[0].system).toMatch(/it is NOT their answer/);

    expect(report.perQuestion).toEqual([
      { question: 'Tell me about a migration you led.', assessment: 'Good scope; add the outcome.' },
      { question: 'Why are you leaving your current role?', assessment: NO_ANSWER_CAPTURED },
      { question: 'What is your biggest weakness?', assessment: 'Honest; give an example.' },
    ]);
  });

  it('with no captured speech there is no model call — the report says nothing was captured', async () => {
    const sid = session();
    asked(sid, 'Tell me about a migration you led.', T0, 'I led the Kafka migration at Acme.');
    asked(sid, 'Why this company?', T0 + 4_000, 'Because of the mission.');
    const report = await generateReport(sid);
    expect(h.calls).toHaveLength(0);
    expect(report.summary).toMatch(/No spoken answers were captured/);
    expect(report.strengths).toEqual([]);
    expect(report.perQuestion.map((p) => p.assessment)).toEqual([NO_ANSWER_CAPTURED, NO_ANSWER_CAPTURED]);
  });

  it('a reply committed after the next question (echo hold) is still the answer to the question it followed', async () => {
    const sid = session();
    asked(sid, 'Which database did you choose for the ledger?', T0, 'S1');
    asked(sid, 'What was the hardest part of the rollout?', T0 + 600, 'S2'); // written BEFORE the reply…
    said(sid, 'We chose CockroachDB for multi-region writes.', T0 + 100); // …which was spoken first
    h.reply = { summary: 's', strengths: [], improvements: [], perQuestion: [{ n: 1, assessment: 'ok' }] };
    const report = await generateReport(sid);
    expect(h.calls[0].user).toMatch(/\[1\] Interviewer asked: Which database did you choose for the ledger\?\nCandidate said: "We chose CockroachDB/);
    expect(report.perQuestion[1]).toEqual({ question: 'What was the hardest part of the rollout?', assessment: NO_ANSWER_CAPTURED });
  });

  it('a long session keeps every question — no blind cut-off — and the input stays bounded', async () => {
    const sid = session();
    const filler = 'I worked through the problem with the team, measured it, and shipped it in stages. '.repeat(10);
    for (let i = 1; i <= 40; i++) {
      asked(sid, `Question ${i}: tell me about project ${i}?`, T0 + i * 10_000, `Suggestion ${i}.`);
      said(sid, `${filler}Project ${i} marker token Z${i}Z.`, T0 + i * 10_000 + 1_000);
    }
    h.reply = { summary: 's', strengths: [], improvements: [], perQuestion: [] };
    const report = await generateReport(sid);
    const user = h.calls[0].user;
    expect(user).toContain('[40] Interviewer asked: Question 40');
    expect(user).toContain('Z40Z'); // the LAST answer's distinctive detail survives
    expect(user.length).toBeLessThan(40_000);
    expect(report.perQuestion).toHaveLength(40);
  });

  it("Sparring keeps its own spoken-answer feedback report", async () => {
    const sid = session('sparring');
    const report = await generateReport(sid);
    expect(h.sparring).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(report.summary).toBe('sparring');
  });
});
