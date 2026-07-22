import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';

/**
 * Meeting Copilot ACCEPTANCE suite (Prompt 7) — a deterministic transcript
 * fixture through the REAL engine (sql.js db, real persistence, real trigger
 * policy), with the providers scripted. Pins the mode's contract:
 *  - greetings/small talk: silence, and the classifier is never even called
 *  - an explicit action item becomes ONE card (duplicates suppressed)
 *  - an unanswered question matures into an open-question card
 *  - a context card retrieves a document fact and carries chunk provenance
 *  - hard pause wins over everything
 *  - the report is grounded: invented owners/dates are nulled, explicit kept
 *  - ambient cards emit ONLY generic contribution events (no legacy twins)
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  salienceCalls: 0,
  chatJson: (async () => ({})) as (req: { system: string; user: string }) => Promise<unknown>,
  retrieveCalls: [] as unknown[][],
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
vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, payload: unknown) => h.events.push({ ch, payload }),
}));
vi.mock('../../windows/overlayWindow', () => ({
  getOverlayWindow: () => null,
  showOverlay: vi.fn(),
}));
vi.mock('../../windows/mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../security/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  openai: () => {
    throw new Error('network disabled in tests');
  },
}));
vi.mock('../openai/answer', () => ({ streamAnswer: vi.fn() }));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../rag/retriever', () => ({
  retrieve: (...args: unknown[]) => {
    h.retrieveCalls.push(args);
    return Promise.resolve([
      {
        id: 'cx1',
        sourceType: 'company',
        content: 'Enterprise plan: $99 per seat, annual billing, includes SSO.',
        score: 0.82,
      },
    ]);
  },
}));
// The whole provider surface, scripted — no OpenAI module chain ever loads.
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'chat') {
      return {
        json: (req: { system: string; user: string }) => {
          if (req.system.startsWith('You watch one turn')) h.salienceCalls += 1;
          return h.chatJson(req);
        },
        stream: () => {
          throw new Error('chat.stream not used in this suite');
        },
      };
    }
    if (cap === 'realtimeStt') {
      return { open: () => ({ appendAudio: vi.fn(), stop: vi.fn() }) };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { engine } from './engine';
import { getOrGenerateMeetingReport } from './meetingReport';

const evts = (ch: string) => h.events.filter((e) => e.ch === ch);
const contribs = (sessionId: string) =>
  h.db
    .select()
    .from(schema.contributions)
    .all()
    .filter((c) => c.sessionId === sessionId);

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Default classifier script: greetings never reach it; plain statements are
 *  not salient; the pricing turn is a confident context signal. */
const defaultChatJson = async (req: { system: string; user: string }): Promise<unknown> => {
  if (req.system.startsWith('You watch one turn')) {
    if (req.user.includes('enterprise pricing')) {
      return {
        salient: true,
        kind: 'context',
        confidence: 0.9,
        title: 'Enterprise pricing',
        owner: null,
        deadline: null,
      };
    }
    return { salient: false, kind: null, confidence: 0, title: '', owner: null, deadline: null };
  }
  if (req.system.startsWith('You surface one short background card')) {
    return {
      relevant: true,
      title: 'Enterprise pricing',
      body: 'The enterprise plan is $99 per seat with annual billing and SSO [1].',
    };
  }
  throw new Error(`unscripted chat.json call: ${req.system.slice(0, 40)}`);
};

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  vi.useFakeTimers();
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  h.events.length = 0;
  h.retrieveCalls.length = 0;
  h.salienceCalls = 0;
  h.chatJson = defaultChatJson;
});

let seq = 0;
function startMeeting() {
  const profileId = `mp${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id: profileId, name: 'Test User', targetRole: 'PM', parsedResume: '{"skills":[]}' })
    .run();
  vi.setSystemTime(T0);
  const session = engine.start(profileId, 'general', null, 'key_points', {
    mode: 'meeting',
    presence: 'balanced',
  });
  return { profileId, session };
}

describe('meeting acceptance — the deterministic fixture', () => {
  it('runs the scripted meeting end to end', async () => {
    const { session } = startMeeting();
    const sid = session.id;
    expect(session.mode).toBe('meeting');
    const turn = async (minutes: number, text: string) => {
      vi.setSystemTime(T0 + minutes * MIN);
      await engine.processFinalTranscript(sid, text);
    };

    // --- greetings / small talk: silence, classifier untouched -------------
    await turn(0, 'Hi everyone, good morning!');
    await turn(1, 'Okay.');
    expect(contribs(sid)).toHaveLength(0);
    expect(h.salienceCalls).toBe(0);

    // --- an unanswered question matures into an open-question card ---------
    await turn(2, 'What is our budget for the Q3 campaign?'); // held
    await turn(3, 'Let us move on to the roadmap discussion.'); // 1 turn since
    await turn(4, 'The roadmap has three phases planned.'); // 2 turns → card
    const openQ = contribs(sid).filter((c) => c.kind === 'open_question');
    expect(openQ).toHaveLength(1);
    expect(openQ[0].title).toBe('What is our budget for the Q3 campaign?');

    // --- explicit action item: one card, with the explicit deadline --------
    await turn(6, 'I will send the launch checklist by Friday.');
    const actions = contribs(sid).filter((c) => c.kind === 'action_item');
    expect(actions).toHaveLength(1);
    expect(JSON.parse(actions[0].meta!)).toMatchObject({ deadline: 'by Friday', owner: null });
    expect(actions[0].body).toContain('I will send the launch checklist by Friday.');

    // --- duplicate suppression (all cooldowns already elapsed) -------------
    await turn(9, 'I will send the launch checklist by Friday.');
    expect(contribs(sid).filter((c) => c.kind === 'action_item')).toHaveLength(1);

    // --- context card: retrieves a document fact, carries provenance -------
    await turn(11, 'Yesterday the client asked about enterprise pricing tiers.');
    const ctx = contribs(sid).filter((c) => c.kind === 'context');
    expect(ctx).toHaveLength(1);
    expect(ctx[0].body).toContain('$99 per seat');
    expect(JSON.parse(ctx[0].sourceRefs!)).toContainEqual({ type: 'chunk', id: 'cx1' });
    expect(h.retrieveCalls).toHaveLength(1);

    // --- decision card ------------------------------------------------------
    await turn(13, 'We have decided to go with the phased rollout.');
    expect(contribs(sid).filter((c) => c.kind === 'decision')).toHaveLength(1);

    // --- hard pause always wins ---------------------------------------------
    engine.togglePause(sid);
    const before = contribs(sid).length;
    await turn(15, 'I will finish the budget summary by Monday.');
    expect(contribs(sid)).toHaveLength(before);
    engine.togglePause(sid);

    // --- ambient cards are generic-only: no legacy answer-event twins -------
    expect(evts(EVENTS.questionDetected)).toHaveLength(0);
    expect(evts(EVENTS.answerDelta)).toHaveLength(0);
    const opens = evts(EVENTS.contributionOpen).map(
      (e) => (e.payload as { kind: string }).kind,
    );
    expect(opens.sort()).toEqual(['action_item', 'context', 'decision', 'open_question']);

    // --- transcript persists with the v2 speaker vocabulary -----------------
    const turns = h.db
      .select()
      .from(schema.transcriptChunks)
      .all()
      .filter((r) => r.sessionId === sid);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((r) => r.speaker === 'them')).toBe(true);

    // --- the report is grounded: no invented owners/dates -------------------
    h.chatJson = async (req) => {
      if (!req.system.startsWith('You write the end-of-meeting report')) {
        throw new Error('only the report should run now');
      }
      return {
        summary: 'Launch planning sync: rollout decided, checklist owned, budget open.',
        decisions: [{ text: 'Go with the phased rollout', owner: 'Bob' }], // invented owner
        actionItems: [
          { text: 'Send the launch checklist', owner: 'Alice', deadline: 'by Friday' },
          { text: 'Draft the pricing one-pager', owner: null, deadline: 'March 3rd' }, // invented date
        ],
        openQuestions: ['What is our budget for the Q3 campaign?'],
      };
    };
    const { report } = await getOrGenerateMeetingReport(sid);
    expect(report.decisions[0].owner).toBeNull(); // Bob never spoke
    expect(report.actionItems[0].owner).toBeNull(); // Alice never spoke
    expect(report.actionItems[0].deadline).toBe('by Friday'); // explicit → kept
    expect(report.actionItems[1].deadline).toBeNull(); // invented → nulled
    expect(report.openQuestions).toContain('What is our budget for the Q3 campaign?');

    // Persisted as ONE summary contribution; stop() reuses it (no regenerate).
    engine.stop(sid);
    await Promise.resolve(); // let the fire-and-forget report hook settle
    const summaries = contribs(sid).filter((c) => c.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(JSON.parse(summaries[0].meta!)).toMatchObject({ reportType: 'meeting' });
  });

  it('summoned presence never contributes ambiently', async () => {
    const profileId = `mp${++seq}`;
    h.db
      .insert(schema.profiles)
      .values({ id: profileId, name: 'Quiet User', targetRole: 'PM', parsedResume: '{}' })
      .run();
    vi.setSystemTime(T0);
    const s = engine.start(profileId, 'general', null, 'key_points', {
      mode: 'meeting',
      presence: 'summoned',
    });
    vi.setSystemTime(T0 + MIN);
    await engine.processFinalTranscript(s.id, 'We have decided to cancel the entire project.');
    expect(contribs(s.id)).toHaveLength(0);
    expect(h.salienceCalls).toBe(0);
    engine.stop(s.id);
    await Promise.resolve();
  });
});
