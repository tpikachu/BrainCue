import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';
import type { CompanionStatusEvent } from '@shared/types';

/**
 * Companion EVALUATION HARNESS (Prompt 10) — scripted scenario fixtures driven
 * through the REAL engine (sql.js db, real persistence, real InterjectionPolicy,
 * real memory recall over real vectors) with every provider scripted. Each
 * scenario measures the things that make or break trust:
 *   useful interjections · unnecessary interjections · duplicates ·
 *   time-to-contribution · memory correctness · groundedness · model-call and
 *   budget consumption.
 *
 * The DEFAULT ACCEPTANCE STANDARD pinned here is the Labs release gate:
 *   - zero low-confidence interruptions in quiet (assistive) mode
 *   - no duplicate contribution within the cooldown window
 *   - correct memory recall with provenance (approved-only, why included)
 *   - hard mute prevents ALL automatic contributions (summons still answer)
 *   - stop tears down every audio/provider resource (and no model call after)
 *   - silence/small talk and idle time never spend a model call (no loops)
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  classifyCalls: 0, // companion salience classifier invocations
  cardCalls: 0, // context-card builder invocations
  chatJson: (async () => ({})) as (req: { system: string; user: string }) => Promise<unknown>,
  streamReqs: [] as { system: string; user: string }[],
  retrieveCalls: [] as unknown[][],
  sttStops: [] as ReturnType<typeof vi.fn>[],
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
// companion.mode's summon path uses streamQuickAnswer (real), which imports
// buildMemoryBlock from the answer module — provide it alongside the stub.
vi.mock('../openai/answer', () => ({
  streamAnswer: vi.fn(),
  buildMemoryBlock: (ms: { category: string; content: string }[]) =>
    ms.map((m, i) => `[M${i + 1}] (${m.category}) ${m.content}`).join('\n\n'),
}));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../rag/retriever', () => ({
  retrieve: (...args: unknown[]) => {
    h.retrieveCalls.push(args);
    return Promise.resolve([
      {
        id: 'cx1',
        sourceType: 'note',
        content: 'The launch runbook lives in Notion under Ops/Launches; steps 1-9 are automated.',
        score: 0.8,
      },
    ]);
  },
}));
// The whole provider surface, scripted — no OpenAI module chain ever loads.
// Embeddings are a 4-dim topic space: [formatting, pricing, x, y].
const VEC_FORMAT = [1, 0, 0, 0];
const VEC_OTHER = [0, 1, 0, 0];
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'chat') {
      return {
        json: (req: { system: string; user: string }) => {
          if (req.system.startsWith('You watch one spoken turn')) h.classifyCalls += 1;
          if (req.system.startsWith('You surface one short background card for a user'))
            h.cardCalls += 1;
          return h.chatJson(req);
        },
        stream: async function* (req: { system: string; user: string }) {
          h.streamReqs.push(req);
          yield { type: 'delta', token: 'Here is the grounded answer, briefly.' };
          yield { type: 'usage', prompt: 120, completion: 18 };
        },
      };
    }
    if (cap === 'embedding') {
      const embed = (text: string) =>
        new Float32Array(/bullet|concise|format/i.test(text) ? VEC_FORMAT : VEC_OTHER);
      return {
        identity: () => ({ provider: 'openai', model: 'test-embed', dim: 4 }),
        embedOne: async (text: string) => embed(text),
        embed: async (texts: string[]) => texts.map(embed),
      };
    }
    if (cap === 'realtimeStt') {
      const stop = vi.fn();
      h.sttStops.push(stop);
      return { open: () => ({ appendAudio: vi.fn(), stop }) };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { engine } from './engine';

const evts = (ch: string) => h.events.filter((e) => e.ch === ch);
const contribs = (sessionId: string) =>
  h.db
    .select()
    .from(schema.contributions)
    .all()
    .filter((c) => c.sessionId === sessionId);
const lastStatus = (): CompanionStatusEvent =>
  evts(EVENTS.companionStatus).at(-1)!.payload as CompanionStatusEvent;

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Not-salient default: the policy's cheap gates + this script = silence. */
const notSalient = async (req: { system: string }): Promise<unknown> => {
  if (req.system.startsWith('You watch one spoken turn')) {
    return { salient: false, kind: null, confidence: 0, relevance: 0, title: '' };
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
  h.streamReqs.length = 0;
  h.classifyCalls = 0;
  h.cardCalls = 0;
  h.chatJson = notSalient;
});

let seq = 0;
function startCompanion(opts: {
  companionPresence: 'off' | 'on_demand' | 'assistive' | 'proactive';
  budgetCents?: number | null;
  memoryConsent?: boolean;
}) {
  const profileId = `cp${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id: profileId, name: 'Eval User', targetRole: 'PM', parsedResume: '{"skills":[]}' })
    .run();
  // Global memory consent is a shared settings row — set it explicitly per
  // scenario so ordering can never leak consent between scenarios.
  h.db.delete(schema.settings).run();
  if (opts.memoryConsent) {
    h.db.insert(schema.settings).values({ key: 'memory_enabled', value: '1' }).run();
  }
  vi.setSystemTime(T0);
  const session = engine.start(profileId, 'general', null, 'explanation', {
    mode: 'companion',
    presence: 'summoned', // the engine dial; the policy runs companionPresence
    companionPresence: opts.companionPresence,
    budgetCents: opts.budgetCents,
  });
  const turn = async (minutes: number, text: string) => {
    vi.setSystemTime(T0 + minutes * MIN);
    await engine.processFinalTranscript(session.id, text);
  };
  return { profileId, session, turn };
}

describe('companion evaluation harness — scripted scenarios', () => {
  it('S1 focused work (assistive): zero low-confidence interruptions, silence is free', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'assistive' });
    // Everything the classifier sees scores BELOW the assistive floors.
    h.chatJson = async (req) => {
      if (req.system.startsWith('You watch one spoken turn')) {
        return { salient: true, kind: 'context', confidence: 0.55, relevance: 0.9, title: 'Meh' };
      }
      throw new Error('only salience should run');
    };

    await turn(0, 'Okay.'); // filler — model-free silence
    await turn(1, 'Hello there everyone'); // greeting — model-free silence
    const freeSilence = h.classifyCalls;
    await turn(3, 'The onboarding flow rewrite still needs a decision on the framework.');
    await turn(7, 'I keep going back and forth on the database schema shape.');

    // METRIC unnecessary interjections: 0. Low-confidence NEVER interrupts.
    expect(contribs(session.id)).toHaveLength(0);
    // METRIC model calls: silence/small talk cost zero; substantive turns 2.
    expect(freeSilence).toBe(0);
    expect(h.classifyCalls).toBe(2);

    // No uncontrolled periodic "thinking" loop: half an hour of idle time
    // fires no timers and spends no calls.
    vi.advanceTimersByTime(30 * MIN);
    expect(h.classifyCalls).toBe(2);
    expect(h.cardCalls).toBe(0);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S2 tasks + grounded context (proactive): quoted cards, provenance, dedupe in cooldown', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'proactive' });
    h.chatJson = async (req) => {
      if (req.system.startsWith('You watch one spoken turn')) {
        if (req.user.includes('launch runbook')) {
          return {
            salient: true,
            kind: 'context',
            confidence: 0.9,
            relevance: 0.85,
            title: 'Launch runbook',
          };
        }
        return { salient: false, kind: null, confidence: 0, relevance: 0, title: '' };
      }
      if (req.system.startsWith('You surface one short background card for a user')) {
        return {
          relevant: true,
          title: 'Launch runbook',
          body: 'Your runbook covers this: steps 1-9 are automated in Notion under Ops/Launches [1].',
        };
      }
      throw new Error(`unscripted: ${req.system.slice(0, 40)}`);
    };

    // Explicit task → deterministic card that QUOTES the user's words.
    await turn(0, 'I will send the revised launch checklist to legal by Friday.');
    const tasks = contribs(session.id).filter((c) => c.kind === 'action_item');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].body).toContain('> I will send the revised launch checklist to legal by Friday.');
    expect(h.classifyCalls).toBe(0); // heuristic path — no model call

    // METRIC duplicates: the same commitment again → suppressed (dedupe),
    // even though the per-kind cooldown (90s) has already elapsed.
    await turn(3, 'I will send the revised launch checklist to legal by Friday.');
    expect(contribs(session.id).filter((c) => c.kind === 'action_item')).toHaveLength(1);

    // Grounded context card: exists only because retrieval found something,
    // and carries its chunk provenance.
    await turn(6, 'Where did we document the launch runbook steps again for this quarter?');
    const ctx = contribs(session.id).filter((c) => c.kind === 'context');
    expect(ctx).toHaveLength(1);
    expect(ctx[0].body).toContain('[1]');
    expect(JSON.parse(ctx[0].sourceRefs!)).toContainEqual({ type: 'chunk', id: 'cx1' });

    // METRIC time-to-contribution: every card lands in its own turn's tick
    // (createdAt equals the turn's clock — no deferred queues).
    const turnTimes = new Set([T0, T0 + 6 * MIN]);
    for (const c of contribs(session.id)) expect(turnTimes.has(c.createdAt)).toBe(true);

    // Ambient cards are generic-only — no legacy Q&A twins.
    expect(evts(EVENTS.questionDetected)).toHaveLength(0);
    expect(evts(EVENTS.answerDelta)).toHaveLength(0);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S3 memory correctness: approved-only recall, provenance, why, vector re-gate', async () => {
    const { profileId, session, turn } = startCompanion({
      companionPresence: 'proactive',
      memoryConsent: true,
    });
    const vec = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    const mem = (id: string, status: string, content: string) => ({
      id,
      profileId,
      packId: null,
      category: 'preference',
      content,
      confidence: 0.9,
      importance: 0.8,
      sensitive: 0,
      status,
      embedProvider: 'openai',
      embedModel: 'test-embed',
      embedDim: 4,
      embedVector: vec(VEC_FORMAT),
      createdAt: T0 - 1000,
      updatedAt: T0 - 1000,
    });
    h.db.insert(schema.memories).values(mem('mem-ok', 'approved', 'Prefers concise bullet answers in reviews.')).run();
    h.db.insert(schema.memories).values(mem('mem-pending', 'pending', 'PENDING must never surface.')).run();
    h.db.insert(schema.memories).values(mem('mem-rejected', 'rejected', 'REJECTED must never surface.')).run();

    h.chatJson = async (req) => {
      if (req.system.startsWith('You watch one spoken turn')) {
        return {
          salient: true,
          kind: 'memory_suggestion',
          confidence: 0.9,
          relevance: 0.9,
          title: 'Saved preference',
        };
      }
      throw new Error('only salience should run');
    };

    // The turn matches the saved preference's topic (formatting vector).
    await turn(0, 'How should I format the design review feedback bullets?');
    const cards = contribs(session.id).filter((c) => c.kind === 'memory_suggestion');
    expect(cards).toHaveLength(1);
    // METRIC memory correctness: the APPROVED memory, verbatim, with provenance.
    expect(cards[0].body).toBe('Prefers concise bullet answers in reviews.');
    const meta = JSON.parse(cards[0].meta!);
    expect(meta.memoryId).toBe('mem-ok');
    expect(meta.why).toContain('design review feedback');
    expect(JSON.parse(cards[0].sourceRefs!)).toContainEqual({ type: 'memory', id: 'mem-ok' });
    expect(JSON.stringify(contribs(session.id))).not.toContain('PENDING');
    expect(JSON.stringify(contribs(session.id))).not.toContain('REJECTED');

    // The classifier only SUSPECTED a memory tie — when the actual vector
    // disagrees (off-topic turn), the card is refused. No hallucinated recall.
    await turn(5, 'Completely unrelated: the vendor invoice arrived twice this month.');
    expect(contribs(session.id).filter((c) => c.kind === 'memory_suggestion')).toHaveLength(1);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S4 hard mute: zero automatic contributions and zero model calls — summons still answer', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'off' });

    // Turns that would be certain cards in any active posture.
    await turn(1, 'I will send the compliance report to the auditors by Friday.');
    await turn(3, 'Where did we document the launch runbook steps for this quarter?');
    expect(contribs(session.id)).toHaveLength(0);
    expect(h.classifyCalls).toBe(0);
    expect(h.cardCalls).toBe(0);
    expect(lastStatus().presence).toBe('off');

    // An explicit summon is the user asking — it must still answer, spoken
    // with the ONE persona source (the preamble leads the system prompt).
    vi.setSystemTime(T0 + 5 * MIN);
    await engine.askActive('What is our launch runbook status?');
    const answers = contribs(session.id).filter((c) => c.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0].body).toBe('Here is the grounded answer, briefly.');
    expect(h.streamReqs).toHaveLength(1);
    expect(h.streamReqs[0].system.startsWith('Your name is BrainCue.')).toBe(true);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S5 budget: the hard cap stops model spend, is visible, and summons stay allowed', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'assistive', budgetCents: 1 });
    // Every substantive turn classifies (not salient → no card, no cooldown),
    // burning the flat classify estimate until the 1¢ budget is gone.
    for (let i = 0; i < 20; i++) {
      await turn(i * 3, `Substantive engineering topic number ${i} needs some thought here.`);
    }
    expect(h.classifyCalls).toBe(20); // 20 × 0.05¢ = 1.0¢ — budget consumed
    const status = lastStatus();
    expect(status.cost.exhausted).toBe(true);
    expect(status.cost.warned).toBe(true);
    expect(status.cost.estCents).toBeGreaterThanOrEqual(1);

    // METRIC budget consumption: past the cap, ambient work spends NOTHING.
    await turn(63, 'Another substantive topic that would normally be classified.');
    await turn(66, 'I will send the budget breach summary by Friday.'); // even heuristic tasks
    expect(h.classifyCalls).toBe(20);
    expect(contribs(session.id)).toHaveLength(0);

    // The user asking is never budget-gated — summon still answers.
    vi.setSystemTime(T0 + 70 * MIN);
    await engine.askActive('Give me the summary anyway?');
    expect(contribs(session.id).filter((c) => c.kind === 'answer')).toHaveLength(1);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S6 teardown: stop releases the transcriber and freezes all model spend', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'proactive' });
    await turn(1, 'I will send the retro notes to the whole team by Friday.');
    expect(contribs(session.id)).toHaveLength(1);

    const stt = h.sttStops.at(-1)!;
    expect(stt).not.toHaveBeenCalled();
    engine.stop(session.id);
    await Promise.resolve();
    // Every audio/provider resource released…
    expect(stt).toHaveBeenCalledTimes(1);

    // …and a dead session accepts nothing: no rows, no events, no model calls.
    const callsBefore = h.classifyCalls + h.cardCalls;
    const rowsBefore = contribs(session.id).length;
    vi.setSystemTime(T0 + 10 * MIN);
    await engine.processFinalTranscript(session.id, 'I will send one more thing by Friday.');
    expect(contribs(session.id)).toHaveLength(rowsBefore);
    expect(h.classifyCalls + h.cardCalls).toBe(callsBefore);
  });

  it('S7 do-not-disturb: inside the window, salient turns are silence at zero cost', async () => {
    // The DND window is minutes-of-day against the (faked) local clock —
    // compute the window around whatever T0 is in this machine's timezone.
    const nowMin = new Date(T0).getHours() * 60 + new Date(T0).getMinutes();
    const dnd = [{ startMin: (nowMin - 30 + 1440) % 1440, endMin: (nowMin + 30) % 1440 }];
    h.db.delete(schema.settings).run();
    h.db
      .insert(schema.settings)
      .values({ key: 'companion_prefs', value: JSON.stringify({ presence: 'proactive', dnd }) })
      .run();

    const profileId = `cp${++seq}`;
    h.db
      .insert(schema.profiles)
      .values({ id: profileId, name: 'DND User', targetRole: 'PM', parsedResume: '{}' })
      .run();
    vi.setSystemTime(T0);
    // No explicit start-time posture → the stored prefs (with DND) apply.
    const session = engine.start(profileId, 'general', null, 'explanation', { mode: 'companion' });

    vi.setSystemTime(T0 + MIN);
    await engine.processFinalTranscript(session.id, 'I will send the summary to the board by Friday.');
    expect(contribs(session.id)).toHaveLength(0);
    expect(h.classifyCalls).toBe(0);

    engine.stop(session.id);
    await Promise.resolve();
  });

  it('S8 live presence change: the Cue Card dial takes effect immediately and is broadcast', async () => {
    const { session, turn } = startCompanion({ companionPresence: 'proactive' });
    expect(lastStatus().presence).toBe('proactive');

    expect(engine.setPresenceActive('off')).toEqual({ applied: true });
    expect(lastStatus().presence).toBe('off');
    await turn(2, 'I will send the roadmap update to everyone by Friday.');
    expect(contribs(session.id)).toHaveLength(0); // hard mute, instantly

    engine.setPresenceActive('proactive');
    await turn(5, 'I will send the roadmap update to everyone by Friday.');
    expect(contribs(session.id).filter((c) => c.kind === 'action_item')).toHaveLength(1);

    engine.stop(session.id);
    await Promise.resolve();
  });
});
