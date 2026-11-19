import type { Row } from '../metrics/report';

/**
 * PERF-01 live driver: which latency record belongs to which fixture
 * (bench/perf01.driver.ts). Pure, so the real collection code is tested
 * offline (perf01.collect.test.ts, perf01.driver.test.ts).
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
 *
 * **Takes.** A record is written only when a take FINISHES. A corrected
 * question starts a new take on the same card while the earlier take's
 * finished record stays in the file. So a question is finished only when
 * its CURRENT take is: the latest take main announced for the card
 * (`latencyTake`, seen by the driver in the Cue Card page), or a later one
 * in the file. An earlier finished take is never the sample, and never
 * makes the question look settled.
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
  /** Its latest wording (the card title, revisions included). */
  text: string;
  /** When the card opened (same clock as the records). */
  at?: number;
  /** The latest take main announced for its card (`latencyTake`). This is
   *  how a replacement take that is still running is seen at all. */
  take?: number;
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

function windowOf(at: number, windows: FixtureWindow[]): string | null {
  const sorted = [...windows].sort((a, b) => a.audioStartAt - b.audioStartAt);
  for (let i = sorted.length - 1; i >= 0; i--) if (at >= sorted[i].audioStartAt) return sorted[i].id;
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

/** A detected question's own attribution (before any record of it exists). */
function attributeQuestion(q: DetectedQuestion, questions: Map<string, DetectedQuestion>, fixtures: FixtureText[], windows: FixtureWindow[]): Attribution {
  return attribute({ questionId: q.id, take: q.take ?? 0, finalAt: q.at ?? Number.POSITIVE_INFINITY }, questions, fixtures, windows);
}

/** The question's current take: the latest announced, or a later one on file. */
export function currentTake(questionId: string, rows: Row[], q?: DetectedQuestion): number {
  return Math.max(q?.take ?? 0, ...rows.filter((r) => r.questionId === questionId).map((r) => r.take));
}

/** The finished record of the question's current take, if it has one. */
export function currentRecord(questionId: string, rows: Row[], q?: DetectedQuestion): Row | null {
  const take = currentTake(questionId, rows, q);
  return rows.find((r) => r.questionId === questionId && r.take >= take && r.outcome && r.outcome !== 'superseded') ?? null;
}

export interface SamplePick {
  /** The question the fixture is sampled on: the first one detected for it. */
  questionId: string | null;
  /** That question's CURRENT take, finished. Null while it is still running. */
  sample: Row | null;
  /** The chosen question's current take has not finished (a replacement in flight). */
  pending: { questionId: string; take: number } | null;
  /** Other questions attributed to the fixture (a split final), not sampled. */
  extraQuestions: string[];
  /** Earlier takes written as superseded, across the fixture's questions. */
  superseded: number;
}

/** The sample for one fixture among every record and detected question attributed to it. */
export function pickSample(rows: Row[], attributions: Attribution[], fixtureId: string, questions: Map<string, DetectedQuestion> = new Map(), fixtures: FixtureText[] = [], windows: FixtureWindow[] = []): SamplePick {
  const mine = rows.filter((_, i) => attributions[i].fixtureId === fixtureId);
  const ids = new Set(mine.map((r) => r.questionId));
  for (const q of questions.values()) if (attributeQuestion(q, questions, fixtures, windows).fixtureId === fixtureId) ids.add(q.id);
  const superseded = mine.filter((r) => r.outcome === 'superseded').length;
  const firstSeen = (id: string) => Math.min(questions.get(id)?.at ?? Number.POSITIVE_INFINITY, ...mine.filter((r) => r.questionId === id).map((r) => r.finalAt));
  const ordered = [...ids].sort((a, b) => firstSeen(a) - firstSeen(b));
  if (!ordered.length) return { questionId: null, sample: null, pending: null, extraQuestions: [], superseded };
  const [chosen, ...extra] = ordered;
  const sample = currentRecord(chosen, rows, questions.get(chosen));
  return {
    questionId: chosen,
    sample,
    pending: sample ? null : { questionId: chosen, take: currentTake(chosen, rows, questions.get(chosen)) },
    extraQuestions: extra,
    superseded,
  };
}

/** Questions whose current take has not finished. When there are none, no
 *  answer of this block is in flight, so the next fixture's timing cannot be
 *  slowed or taken over by an earlier one. */
export function unsettled(rows: Row[], questions: Map<string, DetectedQuestion>): string[] {
  return [...questions.values()].filter((q) => !currentRecord(q.id, rows, q)).map((q) => q.id);
}

export interface CollectDeps {
  readRows(): Row[];
  readQuestions(): Promise<Map<string, DetectedQuestion>>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Collected extends SamplePick {
  attribution: Attribution | null;
  timedOut: boolean;
}

/** Wait for THIS fixture's sample: its first question's current take,
 *  finished. Records for any other fixture are ignored here. The block's
 *  lines are finalized from all the raw evidence at its end (driver
 *  `reconcileBlock`), so a take that finishes later is still the one saved. */
export async function collectAnswer(deps: CollectDeps, fixture: FixtureText, fixtures: FixtureText[], windows: FixtureWindow[], timeoutMs: number, pollMs = 250): Promise<Collected> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const rows = deps.readRows();
    const questions = await deps.readQuestions();
    const attributions = attributeAll(rows, questions, fixtures, windows);
    const pick = pickSample(rows, attributions, fixture.id, questions, fixtures, windows);
    if (pick.sample) return { ...pick, attribution: attributions[rows.indexOf(pick.sample)], timedOut: false };
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
