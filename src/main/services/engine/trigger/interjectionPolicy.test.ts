import { describe, expect, it, vi } from 'vitest';

// companionSalience.ts touches the provider registry at import; the policy
// tests inject their own classifier, so the registry is stubbed out entirely.
vi.mock('../../../providers/registry', () => ({
  providerFor: () => ({
    json: async () => {
      throw new Error('registry must not be reached — tests inject classifiers');
    },
  }),
}));

import { InterjectionPolicy } from './interjectionPolicy';
import { CostMeter } from '../companion/costMeter';
import type {
  CompanionSalienceClassifier,
  CompanionSalienceResult,
} from './companionSalience';

const never: CompanionSalienceClassifier = async () => {
  throw new Error('classifier must not be called for this turn');
};
const scripted =
  (result: CompanionSalienceResult | null): CompanionSalienceClassifier =>
  async () =>
    result;

const salient = (over: Partial<CompanionSalienceResult>): CompanionSalienceResult => ({
  salient: true,
  kind: 'context',
  confidence: 0.9,
  relevance: 0.9,
  title: 'A title',
  ...over,
});

const T0 = 1_000_000;
const MIN = 60_000;
const meter = (budgetCents: number | null = null) => new CostMeter({ budgetCents });

const policy = (over: Partial<ConstructorParameters<typeof InterjectionPolicy>[0]> = {}) =>
  new InterjectionPolicy({
    presence: 'proactive',
    meter: meter(),
    classify: never,
    ...over,
  });

// A turn substantive enough to reach the classifier (not short/greeting/filler).
const AMBIGUOUS = 'The migration plan for the billing service still worries me a lot.';
// A turn the heuristics classify as an explicit action item deterministically
// (commitment language + a "by …" deadline — see meetingHeuristics).
const TASK = 'I will send the updated draft to the review board by tomorrow.';

describe('hard mute and presence gates', () => {
  it('off = hard mute: even a screaming-obvious task is silence', async () => {
    const p = policy({ presence: 'off' });
    const d = await p.evaluate(TASK, T0);
    expect(d).toMatchObject({ act: false, reason: 'hard-mute' });
  });

  it('on_demand: summon-only — no automatic contributions', async () => {
    const p = policy({ presence: 'on_demand' });
    const d = await p.evaluate(TASK, T0);
    expect(d).toMatchObject({ act: false, reason: 'summoned-only' });
  });

  it('live setPresence to off stops contributions instantly', async () => {
    const p = policy({ classify: scripted(salient({})) });
    expect((await p.evaluate(TASK, T0)).act).toBe(true);
    p.setPresence('off');
    const d = await p.evaluate('I will file the quarterly compliance report on Friday.', T0 + 10 * MIN);
    expect(d).toMatchObject({ act: false, reason: 'hard-mute' });
  });

  it('setPresence ignores unknown vocabulary', () => {
    const p = policy();
    p.setPresence('quiet'); // meeting vocabulary — not companion's
    expect(p.currentPresence).toBe('proactive');
  });
});

describe('DND windows (injectable clock)', () => {
  const at = (h: number, m = 0) => () => new Date(2026, 6, 22, h, m, 0);

  it('inside a same-day window: silence, no classifier call', async () => {
    const p = policy({ dnd: [{ startMin: 9 * 60, endMin: 17 * 60 }], clock: at(12) });
    expect(await p.evaluate(TASK, T0)).toMatchObject({ act: false, reason: 'dnd' });
  });

  it('outside the window: acts normally', async () => {
    const p = policy({ dnd: [{ startMin: 9 * 60, endMin: 17 * 60 }], clock: at(18) });
    expect((await p.evaluate(TASK, T0)).act).toBe(true);
  });

  it('a midnight-spanning window (22:00–07:00) covers both sides', async () => {
    const w = [{ startMin: 22 * 60, endMin: 7 * 60 }];
    expect(await policy({ dnd: w, clock: at(23) }).evaluate(TASK, T0)).toMatchObject({ reason: 'dnd' });
    expect(await policy({ dnd: w, clock: at(6) }).evaluate(TASK, T0)).toMatchObject({ reason: 'dnd' });
    expect((await policy({ dnd: w, clock: at(12) }).evaluate(TASK, T0)).act).toBe(true);
  });
});

describe('session budget gate', () => {
  it('an exhausted budget silences BEFORE heuristics or classifier', async () => {
    const m = meter(1); // 1 cent
    // Burn past the budget: flat estimates alone cross 1¢ after a few calls.
    for (let i = 0; i < 25; i++) m.noteCall('classify');
    expect(m.exhausted()).toBe(true);
    const p = policy({ meter: m });
    expect(await p.evaluate(TASK, T0)).toMatchObject({ act: false, reason: 'budget-exhausted' });
  });
});

describe('model-call cost governance', () => {
  it('short/greeting/filler turns never reach the classifier', async () => {
    const p = policy();
    expect((await p.evaluate('Okay.', T0)).act).toBe(false);
    expect((await p.evaluate('Hello there everyone', T0)).act).toBe(false);
    // `never` throws if called — reaching here proves silence was model-free.
  });

  it('the global cooldown window never spends a model call', async () => {
    const calls: number[] = [];
    const counting: CompanionSalienceClassifier = async () => {
      calls.push(1);
      return salient({});
    };
    const p = policy({ classify: counting });
    expect((await p.evaluate(AMBIGUOUS, T0)).act).toBe(true);
    expect(calls.length).toBe(1);
    // Inside the proactive 45s global cooldown: classifier must NOT run.
    const d = await p.evaluate('Another substantive engineering topic came up here.', T0 + 10_000);
    expect(d).toMatchObject({ act: false, reason: 'cooldown' });
    expect(calls.length).toBe(1);
  });

  it('heuristic action items act without any classifier call', async () => {
    const p = policy({ classify: never });
    const d = await p.evaluate(TASK, T0);
    expect(d.act).toBe(true);
    expect(d.kind).toBe('action_item');
    expect(d.usedClassifier).toBe(false);
  });
});

describe('confidence and relevance floors', () => {
  it('below the per-kind confidence floor: silence', async () => {
    const p = policy({ classify: scripted(salient({ confidence: 0.5 })) });
    expect(await p.evaluate(AMBIGUOUS, T0)).toMatchObject({ act: false, reason: 'below-floor' });
  });

  it('assistive floors are stricter than proactive', async () => {
    const c = scripted(salient({ confidence: 0.72, kind: 'context', relevance: 0.9 }));
    expect((await policy({ presence: 'proactive', classify: c }).evaluate(AMBIGUOUS, T0)).act).toBe(true);
    expect(
      await policy({ presence: 'assistive', classify: c }).evaluate(AMBIGUOUS, T0),
    ).toMatchObject({ act: false, reason: 'below-floor' });
  });

  it('grounded kinds (memory/context) also need relevance', async () => {
    const p = policy({ classify: scripted(salient({ kind: 'memory_suggestion', relevance: 0.2 })) });
    expect(await p.evaluate(AMBIGUOUS, T0)).toMatchObject({ act: false, reason: 'below-relevance' });
  });

  it('a low-relevance action item still acts (no relevance floor for tasks)', async () => {
    const p = policy({ classify: scripted(salient({ kind: 'action_item', relevance: 0.1 })) });
    expect((await p.evaluate(AMBIGUOUS, T0)).act).toBe(true);
  });
});

describe('cooldowns, rate cap, and dedupe', () => {
  it('per-kind cooldown outlives the global one', async () => {
    const p = policy({ classify: scripted(salient({ kind: 'context', title: 'First topic' })) });
    expect((await p.evaluate(AMBIGUOUS, T0)).act).toBe(true);
    // Past the 45s global cooldown but inside the 90s per-kind one.
    const d = await p.evaluate('Yet another deep technical consideration to weigh.', T0 + MIN);
    expect(d).toMatchObject({ act: false, reason: 'kind-cooldown' });
  });

  it('the rolling rate cap limits interjections per window', async () => {
    // Alternate kinds so per-kind cooldowns don't mask the rate gate.
    const kinds = ['context', 'action_item', 'memory_suggestion', 'suggested_question'] as const;
    let i = 0;
    const rotating: CompanionSalienceClassifier = async () =>
      salient({ kind: kinds[i % 4], title: `Unique topic number ${i++}` });
    const p = policy({ presence: 'assistive', classify: rotating });
    // Assistive: max 3 per 10 minutes; cooldown 2 min.
    expect((await p.evaluate(`${AMBIGUOUS} one`, T0)).act).toBe(true);
    expect((await p.evaluate(`${AMBIGUOUS} two`, T0 + 3 * MIN)).act).toBe(true);
    expect((await p.evaluate(`${AMBIGUOUS} three`, T0 + 6 * MIN)).act).toBe(true);
    const d = await p.evaluate(`${AMBIGUOUS} four`, T0 + 9 * MIN);
    expect(d).toMatchObject({ act: false, reason: 'rate-limited' });
  });

  it('duplicate titles are suppressed even after every cooldown expires', async () => {
    const p = policy({ classify: scripted(salient({ kind: 'context', title: 'The Same Card!' })) });
    expect((await p.evaluate(AMBIGUOUS, T0)).act).toBe(true);
    const d = await p.evaluate('We circled back to that same discussion topic again.', T0 + 60 * MIN);
    expect(d).toMatchObject({ act: false, reason: 'duplicate' });
  });
});

describe('user speaking state', () => {
  it('interim speech during classification defers the interjection', async () => {
    const p = policy({
      classify: async () => {
        // The user starts talking WHILE the classifier is in flight.
        p.noteInterim(T0 + 1);
        return salient({});
      },
    });
    const d = await p.evaluate(AMBIGUOUS, T0);
    expect(d).toMatchObject({ act: false, reason: 'user-speaking' });
  });
});

describe('active context seam', () => {
  it('the active context is handed to the classifier when set', async () => {
    let seen: string | null = 'unset' as string | null;
    const capture: CompanionSalienceClassifier = async (_t, _r, activeContext) => {
      seen = activeContext;
      return null;
    };
    const p = policy({ classify: capture });
    p.setActiveContext('editor: budget_2026.xlsx');
    await p.evaluate(AMBIGUOUS, T0);
    expect(seen).toBe('editor: budget_2026.xlsx');
  });
});
