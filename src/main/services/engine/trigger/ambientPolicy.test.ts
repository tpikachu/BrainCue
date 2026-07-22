import { describe, expect, it, vi } from 'vitest';

// salience.ts touches the provider registry at import; the policy tests
// inject their own classifier, so the registry is stubbed out entirely.
vi.mock('../../../providers/registry', () => ({
  providerFor: () => ({
    json: async () => {
      throw new Error('registry must not be reached — tests inject classifiers');
    },
  }),
}));

import { AmbientTriggerPolicy } from './ambientPolicy';
import { salienceSchema, type SalienceResult } from './salience';

const never: (turn: string, recent: string[]) => Promise<SalienceResult | null> = async () => {
  throw new Error('classifier must not be called for this turn');
};
const scripted =
  (result: SalienceResult | null) =>
  async (): Promise<SalienceResult | null> =>
    result;

const salient = (over: Partial<SalienceResult>): SalienceResult => ({
  salient: true,
  kind: 'context',
  confidence: 0.9,
  title: 'A title',
  owner: null,
  deadline: null,
  ...over,
});

const T0 = 1_000_000;
const MIN = 60_000;

describe('presence gates', () => {
  it('summoned-only: nothing ambient, ever — classifier never called', async () => {
    const p = new AmbientTriggerPolicy('summoned', never);
    const d = await p.evaluate('We have decided to cancel the entire project.', T0);
    expect(d).toMatchObject({ act: false, reason: 'summoned-only' });
  });

  it('greetings/filler skip WITHOUT a classifier call', async () => {
    const p = new AmbientTriggerPolicy('active', never);
    expect((await p.evaluate('Hi everyone, good morning!', T0)).reason).toBe('greeting');
    expect((await p.evaluate('Sounds good!', T0)).reason).toBe('too-short');
  });

  it('confidence below the presence floor is silence', async () => {
    const p = new AmbientTriggerPolicy(
      'quiet',
      scripted(salient({ kind: 'context', confidence: 0.6 })), // quiet floor: 0.85
    );
    const d = await p.evaluate('The roadmap has three phases planned.', T0);
    expect(d).toMatchObject({ act: false, reason: 'below-floor', usedClassifier: true });
  });

  it('warnings need ≥0.85 confidence at EVERY presence level', async () => {
    const low = new AmbientTriggerPolicy('active', scripted(salient({ kind: 'warning', confidence: 0.7 })));
    expect((await low.evaluate('That contradicts the earlier budget number.', T0)).act).toBe(false);
    const high = new AmbientTriggerPolicy('active', scripted(salient({ kind: 'warning', confidence: 0.9 })));
    expect((await high.evaluate('That contradicts the earlier budget number.', T0)).act).toBe(true);
  });
});

describe('cooldowns and duplicate suppression', () => {
  it('global cooldown: a second card too soon is suppressed', async () => {
    const p = new AmbientTriggerPolicy('balanced', never); // heuristic candidates only
    const a = await p.evaluate('I will send the launch checklist by Friday.', T0);
    expect(a.act).toBe(true);
    // Different kind (decision), 1s later → global 45s cooldown wins.
    const b = await p.evaluate('We have decided to go with option B.', T0 + 1_000);
    expect(b).toMatchObject({ act: false, reason: 'cooldown' });
  });

  it('per-kind cooldown outlives the global one', async () => {
    const p = new AmbientTriggerPolicy('balanced', never);
    await p.evaluate('I will send the launch checklist by Friday.', T0);
    // 50s later: global (45s) has passed, per-kind (90s) has not.
    const d = await p.evaluate('I will update the pricing deck by Monday.', T0 + 50_000);
    expect(d).toMatchObject({ act: false, reason: 'kind-cooldown' });
  });

  it('exact duplicates are suppressed even after every cooldown', async () => {
    const p = new AmbientTriggerPolicy('balanced', never);
    const first = await p.evaluate('I will send the launch checklist by Friday.', T0);
    expect(first.act).toBe(true);
    const dupe = await p.evaluate('I will send the launch checklist by Friday.', T0 + 10 * MIN);
    expect(dupe).toMatchObject({ act: false, reason: 'duplicate' });
  });
});

describe('open-question tracking', () => {
  it('a question is HELD, then matures after two unanswering turns', async () => {
    const p = new AmbientTriggerPolicy('balanced', scripted(null));
    const held = await p.evaluate('What is our budget for the Q3 campaign?', T0);
    expect(held).toMatchObject({ act: false, reason: 'question-held' });

    expect((await p.evaluate('Let us move on to the roadmap discussion.', T0 + MIN)).act).toBe(false);
    const matured = await p.evaluate('The roadmap has three phases planned.', T0 + 2 * MIN);
    expect(matured).toMatchObject({
      act: true,
      kind: 'open_question',
      title: 'What is our budget for the Q3 campaign?',
      usedClassifier: false,
    });
  });

  it('an answered question never becomes a card', async () => {
    const p = new AmbientTriggerPolicy('balanced', scripted(null));
    await p.evaluate('What is our budget for the Q3 campaign?', T0);
    await p.evaluate('The budget is fifty thousand dollars.', T0 + MIN); // shares "budget"
    const later = await p.evaluate('The roadmap has three phases planned.', T0 + 2 * MIN);
    const after = await p.evaluate('Marketing wants two more weeks of lead time.', T0 + 3 * MIN);
    expect(later.kind).not.toBe('open_question');
    expect(after.kind).not.toBe('open_question');
  });
});

describe('classifier output is zod-validated — garbage is silence', () => {
  it('schema rejects malformed shapes', () => {
    expect(salienceSchema.safeParse({ salient: 'yes' }).success).toBe(false);
    expect(salienceSchema.safeParse({ salient: true, kind: 'poem', confidence: 0.9 }).success).toBe(false);
    expect(salienceSchema.safeParse({ salient: true, kind: 'context', confidence: 7 }).success).toBe(false);
  });

  it('a null (failed/invalid) classification is silence, not a guess', async () => {
    const p = new AmbientTriggerPolicy('active', scripted(null));
    const d = await p.evaluate('The roadmap has three phases planned.', T0);
    expect(d).toMatchObject({ act: false, reason: 'not-salient' });
  });
});
