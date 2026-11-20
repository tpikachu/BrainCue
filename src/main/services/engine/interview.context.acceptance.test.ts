import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M4 ACCEPTANCE — conversation context at the PROMPT BOUNDARY.
 *
 * The real engine (sql.js db with the real migrations, real persistence,
 * scheduler, conversation context, interview mode and answer prompt); only
 * the provider is scripted, and it records the exact prompt each answer was
 * generated from. What it pins:
 *  - a fact said after character 600 of a long answer is recalled 30+
 *    exchanges later, and again after Stop → Resume (the 600-char clip at
 *    storage, and the insert-time ordering of persisted turns, broke these);
 *  - a reply still in the echo hold when the next question arrives stays
 *    attached to ITS question after resume (spoken-time persistence);
 *  - referential follow-ups keep the subject; topic switches do not;
 *  - nothing crosses sessions, profiles or Spaces — including recall from
 *    the persisted transcript once turns leave memory;
 *  - every prompt stays bounded.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  prompts: [] as { user: string; system: string }[],
  grounds: [] as { profileId: string; query: string; packId: string | null }[],
  json: [] as { system: string; user: string }[],
  noSources: false,
  reply: 'BrainCue cue text.',
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
vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../windows/overlayWindow', () => ({ getOverlayWindow: () => null, showOverlay: vi.fn() }));
vi.mock('../../windows/mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  openai: () => {
    throw new Error('network disabled in tests');
  },
}));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({
  classifyQuestion: async (text: string) => ({ isQuestion: false, text, type: 'followup', confidence: 0, strategy: '' }),
}));
vi.mock('../memory/recall', () => ({ recallMemories: async () => [], markRecalled: () => {}, revalidateRecalled: (_p: string, _k: unknown, m: unknown) => m }));
// The report's Sparring branch (not exercised here) reaches Electron-only modules.
vi.mock('../mock/sparringManager', () => ({ buildSparringReport: () => null }));
// Profile/Space-scoped documents: each profile has its own résumé and JD.
vi.mock('./grounding', () => ({
  ground: async (profileId: string, query: string, packId: string | null) => {
    h.grounds.push({ profileId, query, packId });
    if (h.noSources) return [];
    return [
      { id: `r-${profileId}`, sourceType: 'resume', content: `Résumé of ${profileId}: senior engineer.`, score: 0.8 },
      { id: `j-${packId}`, sourceType: 'jd', content: `JD of ${packId}: requires Kafka.`, score: 0.6 },
    ];
  },
}));
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'chat') {
      return {
        async *stream(req: { system: string; user: string }) {
          h.prompts.push({ user: req.user, system: req.system });
          yield { type: 'delta', token: h.reply };
        },
        // The coaching report: one assessment per numbered exchange.
        json: async (req: { system: string; user: string }) => {
          h.json.push(req);
          const ns = [...req.user.matchAll(/^\[(\d+)\] Interviewer asked/gm)].map((m) => Number(m[1]));
          return { summary: 'ok', strengths: [], improvements: [], perQuestion: ns.map((n) => ({ n, assessment: `A${n}` })) };
        },
      };
    }
    if (cap === 'realtimeStt') return { open: () => ({ appendAudio: vi.fn(), stop: vi.fn() }) };
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { engine } from './engine';
import { ConversationContext, LIMITS } from './interview/conversationContext';
import { assessUtterance } from './interview/questionHeuristics';
import { generateReport, NO_ANSWER_CAPTURED, NOT_DETECTED_PREFIX } from '../session/report';

// ~1,060 characters; the project name and the figure come LAST.
const LONG =
  'So when I joined, the platform team was mostly firefighting, and the first thing I did was sit with each of the on-call engineers for a week to understand where the pages were coming from. ' +
  'A lot of it was noise, alerts that fired on symptoms nobody could act on, so we spent the first month rewriting the alerting rules and deleting about a third of them. ' +
  'That bought us room to look at the real problem, which was the way deployments touched the shared database during business hours. ' +
  'We put together a working group with the product teams, agreed on a freeze window, and wrote down a runbook that everyone could follow without me in the room. ' +
  'Then we did the dry runs, three of them, each one on a copy of production, and each one found something we would have missed. ' +
  'I also made sure support knew exactly what customers would see during the window, so nobody was surprised. ' +
  'By the time we did it for real I was fairly confident, and it went well. ' +
  'That was the Atlas cut-over, and we finished it with 40 minutes of downtime instead of the six hours the old process needed.';
const FACT = '40 minutes of downtime';
const RECALL = 'Coming back to the Atlas cut-over, what was the downtime?';

const T0 = 1_800_000_000_000;
let seq = 0;

function seed(): { profileId: string; packId: string } {
  const profileId = `p${++seq}`;
  const packId = `pack${seq}`;
  h.db.insert(schema.profiles).values({ id: profileId, name: `User ${seq}`, targetRole: 'Engineer' }).run();
  h.db.insert(schema.contextPacks).values({ id: packId, profileId, title: `Space ${seq}`, kind: 'job' }).run();
  return { profileId, packId };
}
function extraSpace(profileId: string): string {
  const packId = `pack${++seq}`;
  h.db.insert(schema.contextPacks).values({ id: packId, profileId, title: `Space ${seq}`, kind: 'job' }).run();
  return packId;
}

/** The interviewer asks; the answer streams (scripted) and completes. */
async function ask(sid: string, q: string) {
  void engine.processFinalTranscript(sid, q);
  await vi.advanceTimersByTimeAsync(100);
}
/** The candidate speaks; the echo guard confirms it after its hold. */
async function say(sid: string, a: string) {
  void engine.processFinalTranscript(sid, a, 'candidate');
  await vi.advanceTimersByTimeAsync(1700);
}
const promptFor = (q: string) => {
  const p = [...h.prompts].reverse().find((x) => x.user.includes(`QUESTION: ${q}`));
  if (!p) throw new Error(`no prompt for: ${q}`);
  return p.user;
};
const conversationOf = (prompt: string) => prompt.slice(prompt.indexOf('CONVERSATION SO FAR'), prompt.indexOf('\nQUESTION: '));

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  h.prompts.length = 0;
  h.grounds.length = 0;
  h.json.length = 0;
  h.noSources = false;
  h.reply = 'BrainCue cue text.';
});
afterEach(() => {
  const cur = (engine as unknown as { current: { sessionId: string } | null }).current;
  if (cur) engine.stop(cur.sessionId);
});

const DRAFT_QUESTION = 'What is your experience building GraphQL APIs?';
const DRAFT_TAIL = "For cache expiry, I'd use a 47-second TTL and fall back to the origin.";
const PROPOSED_ANSWER = "**I'd start with a schema-first design and explain the trade-offs.**\n" +
  'I would check the schema against client needs and keep the implementation easy to change. '.repeat(8) +
  `\n${DRAFT_TAIL}`;

describe('session draft continuity for flexible interview fallback', () => {
  it('keeps the proposed details beyond the old lead for a live follow-up and after Resume, without inventing spoken evidence', async () => {
    h.noSources = true;
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    h.reply = PROPOSED_ANSWER;
    await ask(sid, DRAFT_QUESTION);
    h.reply = 'A follow-up cue.';
    const follow = 'How would you handle the cache expiry?';
    await ask(sid, follow);
    const live = conversationOf(promptFor(follow));
    expect(PROPOSED_ANSWER.indexOf(DRAFT_TAIL)).toBeGreaterThan(LIMITS.suggestionChars);
    expect(live).toContain(DRAFT_TAIL);
    expect(live).toContain('NOT evidence of what was said or done');
    expect(live).not.toMatch(/You said:.*47-second/);
    expect(h.prompts.at(-1)!.system).toContain('Keep it hypothetical until confirmed');
    engine.stop(sid);
    engine.resume(sid);
    const recall = 'Which cache expiry strategy did you suggest for GraphQL?';
    await ask(sid, recall);
    expect(conversationOf(promptFor(recall))).toContain(DRAFT_TAIL);
    expect(h.db.select().from(schema.memories).all()).toEqual([]);
    expect(h.db.select().from(schema.profiles).all().find((p) => p.id === profileId)!.resumeText).toBeNull();
  });

  it('recalls an older draft after other topics, but never carries it into a fresh session', async () => {
    h.noSources = true;
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    h.reply = PROPOSED_ANSWER;
    await ask(sid, DRAFT_QUESTION);
    for (const topic of ['Hiring', 'Leadership', 'Mentoring', 'Feedback', 'Planning']) {
      h.reply = `I'd explain ${topic.toLowerCase()} clearly.`;
      const q = `What is your experience with ${topic}?`;
      await engine.answerQuestion(sid, q); // separate cards; this case tests context, not fuzzy question deduplication
      expect(conversationOf(promptFor(q))).not.toContain(DRAFT_TAIL);
    }
    const recall = 'Which cache expiry strategy did you suggest for GraphQL?';
    await ask(sid, recall);
    expect(conversationOf(promptFor(recall))).toContain(DRAFT_TAIL);
    engine.stop(sid);
    const fresh = engine.start(profileId, 'general', packId).id;
    await ask(fresh, recall);
    expect(promptFor(recall)).not.toContain(DRAFT_TAIL);
  });

  it('also continues a typed Ask with no spoken question or candidate transcript', async () => {
    h.noSources = true;
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    h.reply = PROPOSED_ANSWER;
    await engine.answerQuestion(sid, DRAFT_QUESTION);
    h.reply = 'A follow-up cue.';
    await engine.answerQuestion(sid, 'Why that approach?');
    const block = conversationOf(promptFor('Why that approach?'));
    expect(block).toContain(DRAFT_TAIL);
    expect(block).not.toContain('You said:');
    expect(h.db.select().from(schema.transcriptChunks).all().filter((t) => t.sessionId === sid)).toEqual([]);
  });

  it('uses the existing prompt budget and respects replacing or clearing a draft', () => {
    const c = new ConversationContext();
    c.addSuggestion('draft', DRAFT_QUESTION, PROPOSED_ANSWER);
    const q = 'How would you handle the cache expiry?';
    const draft = c.snapshot(q, { drafts: true }).suggestions;
    expect(draft).toHaveLength(1);
    expect(draft[0].lead).toContain(DRAFT_TAIL);
    expect(draft[0].lead.length).toBeLessThanOrEqual(LIMITS.suggestions * LIMITS.suggestionChars + 20);
    expect(draft[0]).not.toHaveProperty('answer');
    // Existing non-interview callers still get the original compact leads.
    expect(c.snapshot(q).suggestions[0].lead.length).toBeLessThanOrEqual(LIMITS.suggestionChars);
    c.addSuggestion('draft', DRAFT_QUESTION, '**I would use a per-request cache instead.**');
    expect(c.snapshot(q, { drafts: true }).suggestions[0].lead).toContain('per-request');
    expect(JSON.stringify(c.snapshot(q, { drafts: true }))).not.toContain('47-second');
    c.addSuggestion('draft', DRAFT_QUESTION, '');
    expect(c.snapshot(q, { drafts: true }).suggestions).toEqual([]);
  });

  it('remembers a proposed answer when a new card asks the same question again', async () => {
    h.noSources = true;
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    h.reply = PROPOSED_ANSWER;
    await engine.answerQuestion(sid, DRAFT_QUESTION);
    h.reply = 'A consistent new cue.';
    await engine.answerQuestion(sid, DRAFT_QUESTION);
    expect(conversationOf(promptFor(DRAFT_QUESTION))).toContain(DRAFT_TAIL);
    const cards = h.db.select().from(schema.detectedQuestions).all().filter((q) => q.sessionId === sid);
    expect(cards).toHaveLength(2);
  });

  it('excludes only the active card draft, while legacy snapshots keep their old same-question exclusion', () => {
    const c = new ConversationContext();
    c.addSuggestion('first', DRAFT_QUESTION, PROPOSED_ANSWER);
    expect(c.snapshot(DRAFT_QUESTION, { drafts: true, questionId: 'first' }).suggestions).toEqual([]);
    expect(c.snapshot(DRAFT_QUESTION).suggestions).toEqual([]);
    expect(c.snapshot(DRAFT_QUESTION, { drafts: true, questionId: 'new-card' }).suggestions[0]?.lead).toContain(DRAFT_TAIL);
  });

  it('does not reuse old citation numbers as current sources in a session draft', async () => {
    h.noSources = true;
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    h.reply = 'I would use a per-request GraphQL cache. [1]\nThe expiry would be 47 seconds. [M1]';
    await engine.answerQuestion(sid, DRAFT_QUESTION);
    h.reply = 'A follow-up cue.';
    const follow = 'Why that cache expiry?';
    await engine.answerQuestion(sid, follow);
    const block = conversationOf(promptFor(follow));
    expect(block).toContain('47 seconds');
    expect(block).toContain('NOT evidence');
    expect(block).not.toMatch(/\[(?:M)?1\]/);
    // Rendering a draft never edits the answer saved for the original card.
    expect(h.db.select().from(schema.aiAnswers).all().some((a) => a.directAnswer.includes('[M1]'))).toBe(true);
  });

  it('clears a draft without erasing its classifier-detected spoken question boundary', () => {
    const c = new ConversationContext();
    const detected = 'Your GraphQL caching experience.';
    expect(assessUtterance(detected).verdict).not.toBe('question');
    c.addTurn('interviewer', 'Tell me about your leadership.');
    c.addTurn('candidate', 'I mentor the team.');
    c.addTurn('interviewer', detected);
    c.addSuggestion('classified', detected, 'I would use a per-request cache.');
    c.addSuggestion('classified', detected, '');
    c.addTurn('candidate', 'I have used a cache in one service.');
    expect(c.exchanges().map((e) => [e.question, e.said])).toEqual([
      ['Tell me about your leadership.', 'I mentor the team.'],
      [detected, 'I have used a cache in one service.'],
    ]);
    expect(c.snapshot('Why that cache?', { drafts: true }).suggestions).toEqual([]);
    expect(c.snapshot('Why that cache?').suggestions).toEqual([]);
  });
});

describe('M4 — conversation context at the prompt boundary', () => {
  it('recalls a fact after character 600, 30+ exchanges later, and again after Stop → Resume', async () => {
    expect(LONG.indexOf('Atlas')).toBeGreaterThan(600);
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;

    await ask(sid, 'Tell me about a migration you led.');
    await say(sid, LONG);
    for (let i = 1; i <= 31; i++) {
      await ask(sid, `What did you work on in quarter ${i}?`);
      await say(sid, `In quarter ${i} I worked on the reporting service, mostly on caching layer ${i}.`);
    }
    await ask(sid, RECALL);
    const live = promptFor(RECALL);
    expect(live).toContain(FACT); // what they SAID, past character 600, 32 exchanges back
    expect(conversationOf(live)).toMatch(new RegExp(`You said: [^\\n]*${FACT}`)); // labelled as their words
    expect(live.length).toBeLessThan(20_000); // bounded after a long session

    engine.stop(sid);
    engine.resume(sid);
    h.prompts.length = 0;
    await ask(sid, RECALL);
    const resumed = promptFor(RECALL);
    expect(resumed).toContain(FACT);
    expect(conversationOf(resumed)).toMatch(new RegExp(`You said: [^\\n]*${FACT}`));
    expect(resumed.length).toBeLessThan(20_000);
  });

  it('a reply still in the echo hold when the next question arrives stays with ITS question after resume', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    const QA = 'Which database did you choose for the ledger?';
    const REPLY = 'We chose CockroachDB for the ledger because of multi-region writes.';
    const QB = 'What was the hardest part of the rollout?';
    void engine.processFinalTranscript(sid, QA);
    await vi.advanceTimersByTimeAsync(100);
    void engine.processFinalTranscript(sid, REPLY, 'candidate'); // spoken now, confirmed after the hold
    await vi.advanceTimersByTimeAsync(500);
    void engine.processFinalTranscript(sid, QB); // asked before the reply is committed
    await vi.advanceTimersByTimeAsync(2000);

    engine.stop(sid);
    engine.resume(sid);
    const QC = 'How long did the rollout take overall?';
    await ask(sid, QC);
    const conv = conversationOf(promptFor(QC));
    const iA = conv.indexOf(QA);
    const iReply = conv.indexOf(REPLY);
    const iB = conv.indexOf(QB);
    expect(iA).toBeGreaterThan(-1);
    expect(iReply).toBeGreaterThan(iA);
    expect(iB).toBeGreaterThan(iReply); // the reply answered QA, not QB
  });

  it('a referential follow-up keeps the subject; a topic switch does not', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    await ask(sid, 'Tell me about a migration you led.');
    await say(sid, LONG);
    const FOLLOW = 'How did you measure that?';
    await ask(sid, FOLLOW);
    const follow = promptFor(FOLLOW);
    expect(follow).toMatch(/THIS QUESTION FOLLOWS UP ON \[#\d+\] "Tell me about a migration you led\."/);
    expect(follow).toContain(FACT); // the subject carries what they said, details included
    expect(h.grounds.at(-1)!.query).toContain('Atlas'); // retrieval follows the subject too
    await say(sid, 'We tracked error budgets and the incident count every week.');

    const SWITCH = "Let's move on. What do you know about Kubernetes operators?";
    await ask(sid, SWITCH);
    expect(promptFor(SWITCH)).not.toContain('THIS QUESTION FOLLOWS UP ON');
    expect(h.grounds.at(-1)!.query).toBe(SWITCH);
  });

  it('nothing crosses sessions, profiles or Spaces — live, after resume, and from the persisted transcript', async () => {
    const a = seed();
    const b = seed();
    const sidA = engine.start(a.profileId, 'general', a.packId).id;
    await ask(sidA, 'Tell me about a migration you led.');
    await say(sidA, LONG);
    engine.stop(sidA);

    h.grounds.length = 0;
    const sidB = engine.start(b.profileId, 'general', b.packId).id;
    await ask(sidB, 'Tell me about a migration you led.');
    await say(sidB, 'That was the Borealis migration, with 25 minutes of downtime.');
    await ask(sidB, RECALL);
    const pB = promptFor(RECALL);
    expect(pB).not.toContain('Atlas cut-over, and we finished');
    expect(pB).not.toContain(FACT);
    expect(pB).toContain(`Résumé of ${b.profileId}`);
    expect(pB).not.toContain(`Résumé of ${a.profileId}`);
    expect(h.grounds.every((g) => g.profileId === b.profileId && g.packId === b.packId)).toBe(true);
    engine.stop(sidB);

    // The same profile in ANOTHER Space starts with no conversation of A's.
    const otherSpace = extraSpace(a.profileId);
    const sidA2 = engine.start(a.profileId, 'general', otherSpace).id;
    await ask(sidA2, RECALL);
    expect(promptFor(RECALL)).not.toContain(FACT);
    engine.stop(sidA2);

    // Resuming A brings back A — and only A.
    h.grounds.length = 0;
    engine.resume(sidA);
    await ask(sidA, RECALL);
    const pA = promptFor(RECALL);
    expect(pA).toContain(FACT);
    expect(pA).not.toContain('Borealis');
    expect(h.grounds.every((g) => g.profileId === a.profileId && g.packId === a.packId)).toBe(true);
  });

  it('past the in-memory bound, recall searches THIS session\'s persisted transcript — still bounded, still isolated', async () => {
    const saved = { maxTurns: LIMITS.maxTurns };
    LIMITS.maxTurns = 20; // force eviction in a short test
    try {
      const other = seed();
      const sidO = engine.start(other.profileId, 'general', other.packId).id;
      await ask(sidO, 'Tell me about a migration you led.');
      await say(sidO, 'That was the Atlas cut-over too, but with 90 minutes of downtime.');
      engine.stop(sidO);

      const { profileId, packId } = seed();
      const sid = engine.start(profileId, 'general', packId).id;
      await ask(sid, 'Tell me about a migration you led.');
      await say(sid, LONG);
      for (let i = 1; i <= 15; i++) {
        await ask(sid, `What did you work on in quarter ${i}?`);
        await say(sid, `In quarter ${i} I worked on the reporting service, mostly on caching layer ${i}.`);
      }
      await ask(sid, RECALL); // the LONG turn left memory 20 turns ago
      const p = promptFor(RECALL);
      expect(p).toContain(FACT);
      expect(p).not.toContain('90 minutes'); // another session's transcript is never searched
      expect(p.length).toBeLessThan(20_000);
    } finally {
      LIMITS.maxTurns = saved.maxTurns;
    }
  });

  it('a BrainCue suggestion is never presented as what the candidate said; JD stays an employer requirement', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    await ask(sid, 'Tell me about a migration you led.'); // BrainCue suggests "BrainCue cue text."
    await say(sid, LONG);
    const NEXT = 'Why did you choose a freeze window?';
    await ask(sid, NEXT);
    const p = promptFor(NEXT);
    const conv = conversationOf(p);
    expect(conv).toMatch(/BRAINCUE SUGGESTED EARLIER \(cue-card text — NOT evidence[^\n]*\n- for "Tell me about a migration you led\.": BrainCue cue text\./);
    expect(conv).not.toMatch(/You said: BrainCue cue text/);
    expect(p).toContain(`(jd — employer requirement, not the candidate's experience) JD of ${packId}`);
    expect(p).toContain(`(resume — the candidate's own background) Résumé of ${profileId}`);
  });

  // ---- M4 review round 2 ----
  it('an UNPUNCTUATED long answer: the fact after character 600 reaches the prompt, live and after resume', async () => {
    const BARE = LONG.replace(/[.,;!?]/g, ''); // one run-on "sentence", as some transcribers emit
    expect(BARE).not.toMatch(/[.!?;]/);
    expect(BARE.indexOf('Atlas')).toBeGreaterThan(600);
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    await ask(sid, 'Tell me about a migration you led.');
    await say(sid, BARE);
    for (let i = 1; i <= 31; i++) {
      await ask(sid, `What did you work on in quarter ${i}?`);
      await say(sid, `In quarter ${i} I worked on the reporting service, mostly on caching layer ${i}.`);
    }
    await ask(sid, RECALL);
    const live = promptFor(RECALL);
    expect(live).toContain('Atlas cut-over and we finished it with 40 minutes of downtime');
    expect(live.length).toBeLessThan(20_000);

    engine.stop(sid);
    engine.resume(sid);
    h.prompts.length = 0;
    await ask(sid, RECALL);
    const resumed = promptFor(RECALL);
    expect(resumed).toContain('Atlas cut-over and we finished it with 40 minutes of downtime');
    expect(resumed.length).toBeLessThan(20_000);
  });

  it('A, the reply, then B in ONE millisecond (the reply held by the echo guard): A–reply–B after resume and in coaching', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    const QA = 'Which database did you choose for the ledger?';
    const REPLY = 'We chose CockroachDB for the ledger because of multi-region writes.';
    const QB = 'What was the hardest part of the rollout?';
    const t = Date.now();
    void engine.processFinalTranscript(sid, QA); // all three in this millisecond…
    void engine.processFinalTranscript(sid, REPLY, 'candidate'); // …the reply waits in the echo hold
    void engine.processFinalTranscript(sid, QB);
    expect(Date.now()).toBe(t);
    await vi.advanceTimersByTimeAsync(2000);

    engine.stop(sid);
    engine.resume(sid);
    const QC = 'How long did the rollout take overall?';
    await ask(sid, QC);
    const conv = conversationOf(promptFor(QC));
    expect(conv.indexOf(QA)).toBeGreaterThan(-1);
    expect(conv.indexOf(REPLY)).toBeGreaterThan(conv.indexOf(QA));
    expect(conv.indexOf(QB)).toBeGreaterThan(conv.indexOf(REPLY));
    engine.stop(sid);

    const report = await generateReport(sid);
    expect(report.perQuestion.find((p) => p.question === QA)?.assessment).toBe('A1'); // coached as A's answer
    expect(report.perQuestion.find((p) => p.question === QB)?.assessment).toBe(NO_ANSWER_CAPTURED);
  });

  it('a reply to a question detection MISSED is coached under it — never credited to the card before it', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    const A = 'What is your notice period?';
    const B = 'The ranking change you mentioned earlier.'; // the (scripted) classifier says no
    await ask(sid, A);
    await ask(sid, B);
    await say(sid, 'I changed the ranking feature weights after an offline relevance evaluation.');
    engine.stop(sid);
    const cards = h.db.select().from(schema.detectedQuestions).all().filter((q) => q.sessionId === sid);
    expect(cards.map((q) => q.text)).toEqual([A]); // B really has no card

    const report = await generateReport(sid);
    expect(h.json[0].user).toMatch(/\(not detected live\): The ranking change you mentioned earlier\.\nCandidate said: "I changed the ranking/);
    expect(report.perQuestion).toEqual([
      { question: A, assessment: NO_ANSWER_CAPTURED },
      { question: `${NOT_DETECTED_PREFIX}${B}`, assessment: 'A1' },
    ]);
  });

  // ---- M4 review round 3 ----
  it('TIED spoken timestamps: a fact that left the recent window is still recalled, live and after resume', async () => {
    const { profileId, packId } = seed();
    const sid = engine.start(profileId, 'general', packId).id;
    const AT = Date.now(); // every final reports the same spoken time
    const askT = async (q: string) => {
      void engine.processFinalTranscript(sid, q, undefined, { finalAt: AT });
      await vi.advanceTimersByTimeAsync(100);
    };
    const sayT = async (a: string) => {
      void engine.processFinalTranscript(sid, a, 'candidate', { finalAt: AT });
      await vi.advanceTimersByTimeAsync(1700);
    };
    await askT('How did the Atlas cut-over go?');
    await sayT(`That was the Atlas cut-over, and we finished it with ${FACT}.`);
    for (let i = 1; i <= 15; i++) {
      await askT(`What did you build in sprint ${i}?`);
      await sayT(`In sprint ${i} I built the reporting cache number ${i}.`);
    }
    const rows = h.db.select().from(schema.transcriptChunks).all().filter((r) => r.sessionId === sid);
    expect(new Set(rows.map((r) => r.createdAt)).size).toBe(1); // really tied

    await askT(RECALL);
    const live = promptFor(RECALL);
    // Out of the recent window, and supplied by retrieval instead.
    const block = (p: string, head: string) => {
      const i = p.indexOf(head);
      if (i < 0) return '';
      const end = p.indexOf('\n\n', i);
      return end < 0 ? p.slice(i) : p.slice(i, end);
    };
    expect(block(live, 'MOST RECENT TURNS')).not.toBe('');
    expect(block(live, 'MOST RECENT TURNS')).not.toContain(FACT);
    expect(block(live, 'RELEVANT EARLIER TURNS')).toContain(FACT);

    engine.stop(sid);
    engine.resume(sid);
    h.prompts.length = 0;
    await askT(RECALL);
    const resumed = promptFor(RECALL);
    expect(block(resumed, 'MOST RECENT TURNS')).not.toContain(FACT);
    expect(block(resumed, 'RELEVANT EARLIER TURNS')).toContain(FACT);
  });
});
