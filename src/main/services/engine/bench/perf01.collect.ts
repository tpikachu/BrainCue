import type { Row } from '../metrics/report';

/**
 * PERF-01 live driver: which latency record belongs to which fixture
 * (e2e/live-perf01.spec.ts). Pure, so the real collection code is tested
 * offline (perf01.collect.test.ts).
 *
 * A record never names its fixture: the app's latency file holds ids and
 * times only. A record is ATTRIBUTED by:
 *
 *  1. **Text**, first. The question the app detected (its card title, from
 *     the `questionDetected` event and any later revision) is matched
 *     against every fixture of the block. It goes to the clear best match.
 *  2. **Its final's time**, when no text is known. A question missed or
 *     aborted before its card opened has a job id and no text. Its final
 *     falls inside the window of the fixture whose audio was being sent:
 *     from that fixture's first frame to the next fixture's.
 *
 * So a late record for A that is written while B is being asked is still
 * A's. It is never "the newest row", which used to make it B's sample.
 */

export interface FixtureText {
  id: string;
  text: string;
}

/** When a fixture's audio started; its window ends where the next one's starts. */
export interface FixtureWindow {
  id: string;
  audioStartAt: number;
}

/** A question the app detected and opened a card for. */
export interface DetectedQuestion {
  id: string;
  text: string;
}

export type AttributionHow = 'text' | 'window' | 'window-weak-text' | 'none';

export interface Attribution {
  questionId: string;
  take: number;
  outcome?: string;
  finalAt: number;
  fixtureId: string | null;
  how: AttributionHow;
  /** The best text match (fraction of the detected question's content words in the fixture). */
  score: number | null;
  /** The record's final arrived in another fixture's window. */
  late: boolean;
}

/** A detected question matches a fixture when most of its content words are
 *  in it, and clearly better than any other fixture. */
export const MIN_TEXT_SCORE = 0.6;
export const MIN_TEXT_MARGIN = 0.15;

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to us was we were what when where which who why will with would you your about tell walk through time describe explain give some any one'.split(
    ' ',
  ),
);

export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** The fraction of the detected question's content words found in the fixture. */
export function matchScore(detected: string, fixtureText: string): number {
  const words = contentWords(detected);
  if (!words.length) return 0;
  const target = new Set(contentWords(fixtureText));
  return words.filter((w) => target.has(w)).length / words.length;
}

function windowOf(finalAt: number, windows: FixtureWindow[]): string | null {
  const sorted = [...windows].sort((a, b) => a.audioStartAt - b.audioStartAt);
  for (let i = sorted.length - 1; i >= 0; i--) if (finalAt >= sorted[i].audioStartAt) return sorted[i].id;
  return null;
}

export function attribute(row: Pick<Row, 'questionId' | 'take' | 'outcome' | 'finalAt'>, questions: Map<string, DetectedQuestion>, fixtures: FixtureText[], windows: FixtureWindow[]): Attribution {
  const base = { questionId: row.questionId, take: row.take, outcome: row.outcome, finalAt: row.finalAt };
  const inWindow = windowOf(row.finalAt, windows);
  const text = questions.get(row.questionId)?.text;
  if (text && contentWords(text).length >= 2) {
    const scored = fixtures.map((f) => ({ id: f.id, score: matchScore(text, f.text) })).sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (best && best.score >= MIN_TEXT_SCORE && best.score - (second?.score ?? 0) >= MIN_TEXT_MARGIN)
      return { ...base, fixtureId: best.id, how: 'text', score: best.score, late: inWindow !== null && inWindow !== best.id };
    // The text is known but matches no fixture clearly (a merged or garbled
    // question): its window decides, and the evidence check flags it.
    return { ...base, fixtureId: inWindow, how: inWindow ? 'window-weak-text' : 'none', score: best?.score ?? 0, late: false };
  }
  return { ...base, fixtureId: inWindow, how: inWindow ? 'window' : 'none', score: null, late: false };
}

export function attributeAll(rows: Row[], questions: Map<string, DetectedQuestion>, fixtures: FixtureText[], windows: FixtureWindow[]): Attribution[] {
  return rows.map((r) => attribute(r, questions, fixtures, windows));
}

export interface SamplePick {
  /** The fixture's sample: its first detected question, that question's latest take. */
  sample: Row | null;
  /** Other questions attributed to the fixture (a split final), not sampled. */
  extraQuestions: string[];
  superseded: number;
}

/** The sample for one fixture among every record attributed to it. */
export function pickSample(rows: Row[], attributions: Attribution[], fixtureId: string): SamplePick {
  const mine = rows.filter((_, i) => attributions[i].fixtureId === fixtureId);
  const superseded = mine.filter((r) => r.outcome === 'superseded').length;
  const finished = mine.filter((r) => r.outcome && r.outcome !== 'superseded');
  const byQuestion = new Map<string, Row[]>();
  for (const r of finished) byQuestion.set(r.questionId, [...(byQuestion.get(r.questionId) ?? []), r]);
  const firstFinal = (rs: Row[]) => Math.min(...rs.map((r) => r.finalAt));
  const ordered = [...byQuestion.entries()].sort((a, b) => firstFinal(a[1]) - firstFinal(b[1]));
  if (!ordered.length) return { sample: null, extraQuestions: [], superseded };
  const [, takes] = ordered[0];
  const sample = takes.reduce((best, r) => (r.take > best.take ? r : best));
  return { sample, extraQuestions: ordered.slice(1).map(([id]) => id), superseded };
}

/** Every detected question has a finished (non-superseded) record: no
 *  answer of this block is still in flight, so the next fixture's timing
 *  cannot be slowed or taken over by an earlier one. */
export function unsettled(rows: Row[], questions: Map<string, DetectedQuestion>): string[] {
  const finished = new Set(rows.filter((r) => r.outcome && r.outcome !== 'superseded').map((r) => r.questionId));
  return [...questions.keys()].filter((id) => !finished.has(id));
}

export interface CollectDeps {
  readRows(): Row[];
  readQuestions(): Promise<Map<string, DetectedQuestion>>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Collected {
  sample: Row | null;
  attribution: Attribution | null;
  extraQuestions: string[];
  superseded: number;
  timedOut: boolean;
}

/** Wait for THIS fixture's record: attributed to it, finished. Records for
 *  any other fixture are ignored here (they are kept in the raw file and
 *  written to attribution.jsonl at the end of the block). */
export async function collectAnswer(deps: CollectDeps, fixture: FixtureText, fixtures: FixtureText[], windows: FixtureWindow[], timeoutMs: number, pollMs = 250): Promise<Collected> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const rows = deps.readRows();
    const questions = await deps.readQuestions();
    const attributions = attributeAll(rows, questions, fixtures, windows);
    const pick = pickSample(rows, attributions, fixture.id);
    if (pick.sample) {
      const i = rows.indexOf(pick.sample);
      return { ...pick, attribution: attributions[i], timedOut: false };
    }
    if (deps.now() >= deadline) return { ...pick, attribution: null, timedOut: true };
    await deps.sleep(pollMs);
  }
}

/** Wait until nothing is in flight; false if something still is at the deadline. */
export async function settle(deps: CollectDeps, timeoutMs: number, pollMs = 250): Promise<{ settled: boolean; open: string[] }> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const open = unsettled(deps.readRows(), await deps.readQuestions());
    if (!open.length) return { settled: true, open };
    if (deps.now() >= deadline) return { settled: false, open };
    await deps.sleep(pollMs);
  }
}
