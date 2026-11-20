import type { Collected, FixtureText, FixtureWindow } from './perf01.collect';
import type { MeterState } from './perf01.evidence';

/**
 * PERF-01 live budget, the driver's half (e2e/live-perf01.spec.ts). The
 * meter in main (scripts/perf01/live-meter.cjs) is the hard stop: it
 * reserves every provider request's upper bound BEFORE sending it and
 * refuses anything past a cap. That includes setup, classification,
 * follow-up predictions, embeddings and retries, whether or not the provider
 * reports usage.
 *
 * The driver checks before each question that a whole question's worst
 * case still fits, so a run stops cleanly between questions instead of
 * halfway through an answer. After each question it reads the ledger, and
 * stops if anything was refused. Every stop is a recorded outcome: the
 * fixtures left are written as `not-run`, and the block is `stopped`.
 */

/**
 * One question's worst-case reservation, from MEASURED sizes. The offline
 * benchmark records what the meter would reserve for every answer request
 * the real prompt builder produces (simulated-report.json
 * `run.answerReservation`: max 4,365 General, 4,653 Technical, 5,042 in the
 * 32-exchange session). Rounded up:
 *
 * | Request | Reserve |
 * | --- | --- |
 * | answer, one attempt | 6,000 |
 * | classifier, at most one | 1,000 |
 * | follow-up prediction, one | 1,000 |
 * | query embeddings, up to 3 (interim + final + memory) | 1,000 |
 *
 * That is 9,000 tokens and 6 requests, plus 3 requests of headroom for
 * retries. The meter still charges a retry in full. A question that needs
 * more than this is refused by the meter, and the run stops.
 */
export const QUESTION_RESERVE = { tokens: 9_000, requests: 9 } as const;
/** The answer request's share of QUESTION_RESERVE. The offline benchmark
 *  fails if any answer request it builds would reserve more. */
export const ANSWER_RESERVE = 6_000;

/** Setup, once for the run (the seed): JD parsing (a 6 k-character JD with
 *  an 8,192-token ceiling ≈ 11 k), indexing the KB (≈ 6 k), two memories,
 *  and a model warm-up per app process (no tokens). */
export const SETUP_RESERVE = { tokens: 25_000, requests: 30 } as const;

export interface RunCaps {
  /** Questions spoken, the whole run (2 × 31 warm + 10 cold = 72). */
  questions: number;
  /** Reserved tokens (prompt + completion upper bounds), the whole run. */
  tokens: number;
  /** Provider requests, the whole run. */
  requests: number;
  /** Speech-to-text audio, the whole run. */
  sttSeconds: number;
  /** Failed or unpainted questions per block before it stops. */
  failures: number;
}

export const DEFAULT_CAPS: RunCaps = {
  questions: 72,
  tokens: SETUP_RESERVE.tokens + 72 * QUESTION_RESERVE.tokens, // 673,000
  requests: SETUP_RESERVE.requests + 72 * QUESTION_RESERVE.requests, // 678
  sttSeconds: 900, // 72 × (≤ 10 s of speech + 1.5 s of silence) = 828 s at most
  failures: 5,
};

export function capsFromEnv(env: Record<string, string | undefined>): RunCaps {
  const n = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    questions: n(env.PERF01_MAX_QUESTIONS, DEFAULT_CAPS.questions),
    tokens: n(env.PERF01_MAX_TOKENS, DEFAULT_CAPS.tokens),
    requests: n(env.PERF01_MAX_REQUESTS, DEFAULT_CAPS.requests),
    sttSeconds: n(env.PERF01_MAX_STT_SECONDS, DEFAULT_CAPS.sttSeconds),
    failures: n(env.PERF01_MAX_FAILURES, DEFAULT_CAPS.failures),
  };
}

export type Check = { ok: true } | { ok: false; reason: string };

/** May the next question be asked? Its whole worst case must still fit. */
export function canAsk(meter: MeterState | null, caps: RunCaps, asked: number, audioSeconds: number): Check {
  if (!meter) return { ok: false, reason: 'meter-missing: the budget is not being enforced' };
  if (meter.capped) return { ok: false, reason: `budget capped (${meter.capped.reason})` };
  if (asked + 1 > caps.questions) return { ok: false, reason: `question cap (${caps.questions})` };
  if (meter.reservedTokens + QUESTION_RESERVE.tokens > caps.tokens)
    return { ok: false, reason: `token budget: ${meter.reservedTokens.toLocaleString('en-US')} reserved, a question needs ${QUESTION_RESERVE.tokens.toLocaleString('en-US')} of ${caps.tokens.toLocaleString('en-US')}` };
  if (meter.requests + QUESTION_RESERVE.requests > caps.requests) return { ok: false, reason: `request budget: ${meter.requests} of ${caps.requests}` };
  if (meter.sttSeconds + audioSeconds > caps.sttSeconds) return { ok: false, reason: `speech-to-text budget: ${Math.round(meter.sttSeconds)} s of ${caps.sttSeconds} s` };
  return { ok: true };
}

/** After a question: anything refused means the run is over. */
export function afterQuestion(meter: MeterState | null): Check {
  if (!meter) return { ok: false, reason: 'meter-missing: the budget is not being enforced' };
  if (meter.capped) return { ok: false, reason: `budget capped (${meter.capped.reason}, ${meter.capped.cls})` };
  return { ok: true };
}

export interface LoopDeps {
  /** The current ledger (re-read every time: other processes spend too). */
  meter(): MeterState | null;
  /** Questions already asked in the whole run (all blocks). */
  asked(): number;
  /** Wait until no earlier answer is in flight. */
  settle(): Promise<{ settled: boolean; open: string[] }>;
  /** Stream the fixture's speech; resolves when its last frame was sent. */
  send(q: FixtureText): Promise<{ audioStartAt: number; audioEndAt: number }>;
  collect(q: FixtureText, windows: FixtureWindow[]): Promise<Collected>;
  /** Write the fixture's line (rows.jsonl). */
  record(q: FixtureText, c: Collected | null, at: { audioStartAt: number; audioEndAt?: number }, notRun?: string): Promise<void> | void;
  audioSeconds(q: FixtureText): number;
  gap(): Promise<void>;
}

export interface LoopResult {
  status: 'complete' | 'stopped';
  reason?: string;
  windows: FixtureWindow[];
  failures: number;
}

/** One block's questions, in order, under the budget. Every planned
 *  fixture gets a line: its sample, `no-record`, or `not-run` when the
 *  block stopped before it. */
export async function runBlockLoop(deps: LoopDeps, questions: FixtureText[], caps: RunCaps, opts: { countFailures: (c: Collected) => boolean; firstMustPaint?: boolean }): Promise<LoopResult> {
  const windows: FixtureWindow[] = [];
  let failures = 0;
  const stop = async (i: number, reason: string): Promise<LoopResult> => {
    for (const q of questions.slice(i)) await deps.record(q, null, { audioStartAt: Date.now() }, reason);
    return { status: 'stopped', reason, windows, failures };
  };
  for (const [i, q] of questions.entries()) {
    const s = await deps.settle();
    if (!s.settled) return stop(i, `an earlier answer was still in flight (${s.open.join(', ')})`);
    const before = canAsk(deps.meter(), caps, deps.asked(), deps.audioSeconds(q));
    if (!before.ok) return stop(i, before.reason);
    const at = await deps.send(q);
    windows.push({ id: q.id, audioStartAt: at.audioStartAt });
    const c = await deps.collect(q, windows);
    await deps.record(q, c, at);
    if (opts.countFailures(c)) failures++;
    const after = afterQuestion(deps.meter());
    if (!after.ok) return stop(i + 1, after.reason);
    if (i === 0 && opts.firstMustPaint && !c.sample?.firstUsefulAt) return stop(i + 1, 'the first question never painted: is the Cue Card visible on the second screen?');
    if (failures > caps.failures) return stop(i + 1, `more than ${caps.failures} failed or unpainted questions`);
    if (i < questions.length - 1) await deps.gap();
  }
  // The block boundary: work that follows an answer (a follow-up prediction,
  // say) may be refused after the last record was written. One more gap
  // lets it happen inside the block.
  await deps.gap();
  const s = await deps.settle();
  if (!s.settled) return { status: 'stopped', reason: `an answer was still in flight at the end of the block (${s.open.join(', ')})`, windows, failures };
  const end = afterQuestion(deps.meter());
  if (!end.ok) return { status: 'stopped', reason: end.reason, windows, failures };
  return { status: 'complete', windows, failures };
}
