import { describe, expect, it } from 'vitest';
import type { Row } from '../metrics/report';
import { canAsk, DEFAULT_CAPS, QUESTION_RESERVE, runBlockLoop, type LoopDeps, type RunCaps } from './perf01.budget';
import type { Collected, FixtureText } from './perf01.collect';
import type { MeterState } from './perf01.evidence';

/**
 * The live driver's block loop under the budget, OFFLINE. This is the
 * function e2e/live-perf01.spec.ts runs each block with. Its Page, audio
 * and ledger are fakes here. The fake ledger spends the way the meter does
 * (scripts/perf01/live-meter.cjs, tested on its own in perf01.meter.test.ts):
 * it reserves per request, whether or not usage is reported, and it caps.
 */
const meterState = (over: Partial<MeterState> = {}): MeterState => ({
  reservedTokens: 0,
  requests: 0,
  refused: 0,
  sttSeconds: 0,
  unboundedRequests: 0,
  byClass: {},
  models: {},
  stt: null,
  capped: null,
  processes: [],
  ...over,
});

const Q = (n: number): FixtureText[] => Array.from({ length: n }, (_, i) => ({ id: `G${String(i + 1).padStart(2, '0')}`, text: `question ${i + 1}` }));

/** A fake app + ledger: each question spends `spend` tokens (answer, classifier,
 *  prediction, embeddings). Its record may or may not carry usage. */
function fakeApp(ledger: { state: MeterState; caps: RunCaps; asked: number }, opts: { spend?: number; usage?: boolean; paints?: boolean; unsettledAt?: number } = {}) {
  const lines: { id: string; outcome: string; notRun?: string }[] = [];
  const sent: string[] = [];
  let t = 0;
  const deps: LoopDeps = {
    meter: () => ledger.state,
    asked: () => ledger.asked,
    settle: async () => (opts.unsettledAt !== undefined && sent.length === opts.unsettledAt ? { settled: false, open: ['q-late'] } : { settled: true, open: [] }),
    send: async (q) => {
      sent.push(q.id);
      ledger.asked++;
      // The meter reserves as the requests go out — and caps if one does not fit.
      const spend = opts.spend ?? 5_000;
      if (ledger.state.capped || ledger.state.reservedTokens + spend > ledger.caps.tokens) ledger.state.capped = { reason: 'tokens', cls: 'responses', at: t };
      else ledger.state.reservedTokens += spend;
      return { audioStartAt: (t += 10_000), audioEndAt: t + 3_000 };
    },
    collect: async (q): Promise<Collected> => {
      const refused = ledger.state.capped !== null;
      const sample: Row = {
        questionId: `q-${q.id}`,
        sessionId: 's',
        take: 1,
        category: 'general',
        cold: false,
        finalAt: t,
        outcome: refused ? 'failed' : 'answered',
        ...(refused ? { reason: 'network' } : { firstUsefulAt: opts.paints === false ? undefined : t + 1_000 }),
        ...(opts.usage === false || refused ? {} : { promptTokens: 1_700, completionTokens: 200 }),
      };
      return { sample, attribution: null, extraQuestions: [], superseded: 0, timedOut: false };
    },
    record: (q, c, _at, notRun) => void lines.push({ id: q.id, outcome: notRun ? 'not-run' : (c?.sample?.outcome ?? 'no-record'), ...(notRun ? { notRun } : {}) }),
    audioSeconds: () => 4,
    gap: async () => {},
  };
  return { deps, lines, sent };
}

const failed = (c: Collected) => c.sample?.outcome !== 'answered' || !c.sample?.firstUsefulAt;
const caps = (over: Partial<RunCaps> = {}): RunCaps => ({ ...DEFAULT_CAPS, ...over });

describe('PERF-01 block loop under the budget', () => {
  it('the review case: a one-question block with a one-token cap stops BEFORE speaking — never a normal completion', async () => {
    const ledger = { state: meterState(), caps: caps({ tokens: 1 }), asked: 0 };
    const app = fakeApp(ledger, { spend: 2 });
    const r = await runBlockLoop(app.deps, Q(1), ledger.caps, { countFailures: failed });
    expect(r.status).toBe('stopped');
    expect(r.reason).toMatch(/token budget/);
    expect(app.sent).toEqual([]);
    expect(app.lines).toEqual([{ id: 'G01', outcome: 'not-run', notRun: r.reason }]);
  });

  it('a final question whose spending crosses the cap ends the block "stopped", not complete', async () => {
    // The pre-check passes (the reserve fits), the meter refuses mid-answer.
    // Q1 spends 13.5 k and leaves 9.9 k, so Q2's pre-check (9 k) passes; Q2
    // then needs 13.5 k more and the meter refuses it.
    const ledger = { state: meterState(), caps: caps({ tokens: QUESTION_RESERVE.tokens * 2.6 }), asked: 0 };
    const app = fakeApp(ledger, { spend: QUESTION_RESERVE.tokens * 1.5 });
    const r = await runBlockLoop(app.deps, Q(2), ledger.caps, { countFailures: failed });
    expect(app.sent).toEqual(['G01', 'G02']);
    expect(r).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/budget capped/) });
    expect(app.lines.map((l) => l.outcome)).toEqual(['answered', 'failed']);
  });

  it('the questions left when the budget runs short are written as not-run (they stay in the denominator)', async () => {
    const ledger = { state: meterState(), caps: caps({ tokens: QUESTION_RESERVE.tokens * 2 + 1 }), asked: 0 };
    const app = fakeApp(ledger, { spend: QUESTION_RESERVE.tokens });
    const r = await runBlockLoop(app.deps, Q(4), ledger.caps, { countFailures: failed });
    expect(r.status).toBe('stopped');
    expect(app.sent).toEqual(['G01', 'G02']);
    expect(app.lines.map((l) => l.outcome)).toEqual(['answered', 'answered', 'not-run', 'not-run']);
  });

  it('spending accumulates across blocks: the second block sees the first block’s reservations', async () => {
    const ledger = { state: meterState(), caps: caps({ tokens: 5 * QUESTION_RESERVE.tokens }), asked: 0 };
    const first = await runBlockLoop(fakeApp(ledger, { spend: QUESTION_RESERVE.tokens }).deps, Q(3), ledger.caps, { countFailures: failed });
    const app2 = fakeApp(ledger, { spend: QUESTION_RESERVE.tokens });
    const second = await runBlockLoop(app2.deps, Q(3), ledger.caps, { countFailures: failed });
    expect(first.status).toBe('complete');
    expect(second.status).toBe('stopped');
    expect(app2.sent).toEqual(['G01', 'G02']);
    // And the run-wide question cap counts every block too.
    expect(canAsk(meterState(), caps({ questions: 5 }), ledger.asked, 1)).toEqual({ ok: false, reason: 'question cap (5)' });
  });

  it('unreported usage does not stretch the budget: the ledger’s reservations decide, not the records', async () => {
    const ledger = { state: meterState(), caps: caps({ tokens: QUESTION_RESERVE.tokens * 2 + 1 }), asked: 0 };
    const app = fakeApp(ledger, { spend: QUESTION_RESERVE.tokens, usage: false });
    const r = await runBlockLoop(app.deps, Q(3), ledger.caps, { countFailures: failed });
    expect(r.status).toBe('stopped');
    expect(app.sent).toHaveLength(2);
  });

  it('setup and auxiliary spending already in the ledger counts against the same budget', async () => {
    const ledger = { state: meterState({ reservedTokens: 20_000, requests: 25, byClass: { responses: 1, embedding: 24 } }), caps: caps({ tokens: 20_000 + QUESTION_RESERVE.tokens - 1 }), asked: 0 };
    const app = fakeApp(ledger);
    const r = await runBlockLoop(app.deps, Q(1), ledger.caps, { countFailures: failed });
    expect(r.status).toBe('stopped');
    expect(app.sent).toEqual([]);
  });

  it('no ledger (the meter is not loaded) means nothing is asked', async () => {
    const ledger = { state: null as unknown as MeterState, caps: caps(), asked: 0 };
    const app = fakeApp(ledger);
    const r = await runBlockLoop(app.deps, Q(2), ledger.caps, { countFailures: failed });
    expect(r).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/meter-missing/) });
    expect(app.sent).toEqual([]);
  });

  it('an earlier answer still in flight stops the block rather than contaminating the next sample', async () => {
    const ledger = { state: meterState(), caps: caps(), asked: 0 };
    const app = fakeApp(ledger, { unsettledAt: 1 });
    const r = await runBlockLoop(app.deps, Q(3), ledger.caps, { countFailures: failed });
    expect(r).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/still in flight \(q-late\)/) });
    expect(app.lines.map((l) => l.outcome)).toEqual(['answered', 'not-run', 'not-run']);
  });

  it('a warm-up that never paints stops the block (the Cue Card must be visible)', async () => {
    const ledger = { state: meterState(), caps: caps(), asked: 0 };
    const app = fakeApp(ledger, { paints: false });
    const r = await runBlockLoop(app.deps, Q(3), ledger.caps, { countFailures: failed, firstMustPaint: true });
    expect(r).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/never painted/) });
    expect(app.sent).toEqual(['G01']);
  });

  it('control: a block within budget completes with every line answered', async () => {
    const ledger = { state: meterState(), caps: caps(), asked: 0 };
    const app = fakeApp(ledger);
    const r = await runBlockLoop(app.deps, Q(31), ledger.caps, { countFailures: failed, firstMustPaint: true });
    expect(r).toMatchObject({ status: 'complete', failures: 0 });
    expect(app.lines.every((l) => l.outcome === 'answered')).toBe(true);
    expect(r.windows).toHaveLength(31);
  });

  it('the default caps cover the planned run: setup plus 72 questions at their worst case', () => {
    expect(DEFAULT_CAPS.questions).toBe(2 * 31 + 10);
    expect(DEFAULT_CAPS.tokens).toBeGreaterThanOrEqual(25_000 + 72 * QUESTION_RESERVE.tokens);
  });
});
