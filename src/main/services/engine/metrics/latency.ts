/**
 * Live-interview latency instrumentation (docs/23-INTERVIEW-COPILOT.md §8).
 *
 * One record per automatically detected question, with every stage measured
 * separately so a regression points at its cause:
 *
 *   speechEnd → final        the transcriber's endpoint wait (VAD speech-stop,
 *                            or the last interim delta — `speechEndSource`
 *                            says which; the latter is approximate)
 *   final → decision         question detection (rules / classifier)
 *   decision → dispatch      waiting for the answer slot (queue)
 *   dispatch → request       waiting for documents and memory (`retrievalMs`
 *                            and `recallMs` are each one's own run time, which
 *                            may have started on the interim, before the final)
 *   request → first token    the provider: connection, queueing, first token
 *   final → first useful     the first answer WORDS painted in the Cue Card —
 *                            reported by the overlay after paint, and only
 *                            once the text holds a real word (a bare "**" or
 *                            "- " is not an answer)
 *   final → complete         the whole answer streamed
 *
 * Every record ends with an OUTCOME — answered, empty, failed, aborted,
 * superseded or missed — and is written to the sink then, so failed and
 * unanswered questions stay in the sample instead of disappearing from it.
 * A question re-answered after a revision keeps one record (its latest take);
 * the earlier take is written to the sink as `superseded`.
 *
 * Timestamps are wall-clock ms from one machine: main and the overlay share
 * `Date.now()`. No transcript, answer text or key is ever recorded here —
 * only ids, timestamps, counts, route names and outcome codes.
 */

export type Stage =
  | 'speechToFinal'
  | 'finalToDecision'
  | 'decisionToDispatch'
  | 'dispatchToRequest'
  | 'requestToFirstToken'
  | 'finalToFirstToken'
  | 'finalToFirstUseful'
  | 'speechToFirstUseful'
  | 'finalToComplete';

export const STAGES: Stage[] = [
  'speechToFinal',
  'finalToDecision',
  'decisionToDispatch',
  'dispatchToRequest',
  'requestToFirstToken',
  'finalToFirstToken',
  'finalToFirstUseful',
  'speechToFirstUseful',
  'finalToComplete',
];

/** The acceptance buckets: General and simple Technical interview answers
 *  are measured separately, and coding never mixes into either. */
export type LatencyCategory = 'general' | 'technical' | 'coding';
export const CATEGORIES: LatencyCategory[] = ['general', 'technical', 'coding'];

export type Outcome = 'answered' | 'empty' | 'failed' | 'aborted' | 'superseded' | 'missed';
export const OUTCOMES: Outcome[] = ['answered', 'empty', 'failed', 'aborted', 'superseded', 'missed'];

/** Which bucket a question belongs to: coding by the classifier's type;
 *  otherwise the answer STYLE in use (General / Technical) — the user's
 *  choice for the interview, and what shapes the answer. The classifier's
 *  type is recorded alongside (`questionType`), so a run can be re-bucketed;
 *  the rules' type alone is too noisy to split the acceptance samples by. */
export function latencyCategory(questionType: string | undefined, answerFormat: string | undefined): LatencyCategory {
  if (questionType === 'coding') return 'coding';
  return answerFormat === 'technical' ? 'technical' : 'general';
}

export interface QuestionTiming {
  questionId: string;
  sessionId: string;
  /** Increments per take of the question (a revision re-answers it). */
  take: number;
  category: LatencyCategory;
  format?: string;
  questionType?: string;
  speechEndAt?: number;
  /** `vad` = the server's speech-stopped event; `last-delta` = the last
   *  interim word (engines without a VAD event) — approximate. */
  speechEndSource?: 'vad' | 'last-delta';
  finalAt: number;
  decidedAt?: number;
  /** The answer slot was taken and work on the answer started. */
  dispatchAt?: number;
  /** Document retrieval's own run time (it may have started on the interim). */
  retrievalMs?: number;
  /** Memory recall's own run time (likewise). */
  recallMs?: number;
  /** Wait allowance and whether the answer used immediate lexical fallback. */
  groundingBudgetMs?: number;
  groundingDeadlineHit?: boolean;
  /** The first attempt was sent to the provider. */
  requestAt?: number;
  firstTokenAt?: number;
  /** The first painted text with a real word in it (overlay report). */
  firstUsefulAt?: number;
  completedAt?: number;
  outcome?: Outcome;
  /** For `missed`: why (queue-full, paused, late). For `failed`: the error
   *  kind (auth, quota, model, network, …). Codes only, never a message. */
  reason?: string;
  /** First answer of this app process — connection setup not yet paid. */
  cold: boolean;
  detection?: string;
  prefetched?: boolean;
  /** The route that produced the first token (the answering attempt) —
   *  seeded at dispatch, re-marked by the attempt that answers. */
  provider?: string;
  model?: string;
  /** The reasoning effort the answering attempt sent ('not-sent' for a
   *  model without the parameter) — providers/effort.ts. */
  effort?: string;
  /** Attempts that failed before the answering one (same-provider failover). */
  failedAttempts?: number;
  /** Context sizes — counts, never content. */
  chunks?: number;
  memories?: number;
  /** Grounding that had to rank lexically because the query embedding was
   *  late or failed (rag/liveEmbed.ts): 'documents' and/or 'memory'. */
  lexical?: string[];
  /** The provider's reported token usage, when it gives one. */
  promptTokens?: number;
  completionTokens?: number;
  /** Requested processing and the provider's actual tier, kept separate:
   * a Fast request can be served at standard speed. Missing means unknown. */
  requestedServiceTier?: string;
  serviceTier?: string;
  cachedPromptTokens?: number;
}

export interface StageSummary {
  n: number;
  p50: number | null;
  p95: number | null;
}

/** Final → first useful paint over EVERY finished question of a bucket:
 *  one that never painted an answer (failed, empty, aborted, missed) counts
 *  as slower than any answer. A percentile that lands on one is `null` —
 *  "not answered" — so failures can never make the numbers look better. */
export interface EndToEnd {
  n: number;
  unanswered: number;
  p50: number | null;
  p95: number | null;
  withinTarget: { le1500: number; le3000: number };
}

export interface Bucket {
  samples: number;
  outcomes: Record<Outcome, number>;
  stages: Record<Stage, StageSummary>;
  endToEnd: EndToEnd;
}

export interface LatencySummary {
  /** Final → decision over every evaluated interviewer turn, question or not. */
  decisions: StageSummary;
  byCategory: Record<LatencyCategory | 'all', { cold: Bucket; warm: Bucket; all: Bucket }>;
}

/** Nearest-rank percentile over a sorted copy. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export function stageValue(t: QuestionTiming, stage: Stage): number | null {
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined && b >= a ? b - a : null);
  switch (stage) {
    case 'speechToFinal':
      return d(t.speechEndAt, t.finalAt);
    case 'finalToDecision':
      return d(t.finalAt, t.decidedAt);
    case 'decisionToDispatch':
      return d(t.decidedAt, t.dispatchAt);
    case 'dispatchToRequest':
      return d(t.dispatchAt, t.requestAt);
    case 'requestToFirstToken':
      return d(t.requestAt, t.firstTokenAt);
    case 'finalToFirstToken':
      return d(t.finalAt, t.firstTokenAt);
    case 'finalToFirstUseful':
      return d(t.finalAt, t.firstUsefulAt);
    case 'speechToFirstUseful':
      return d(t.speechEndAt, t.firstUsefulAt);
    case 'finalToComplete':
      return t.outcome === 'answered' ? d(t.finalAt, t.completedAt) : null;
  }
}

/** How long an answered record waits for the overlay's paint report before
 *  it is written without one (the Cue Card may be hidden or closed). */
export const PAINT_GRACE_MS = 3000;

type Timer = unknown;

/** Bounded in-memory record of recent questions plus every detection
 *  decision (questions or not — detection latency is paid on every turn). */
export class LatencyRecorder {
  private readonly timings = new Map<string, QuestionTiming>();
  private readonly order: string[] = [];
  private readonly decisions: number[] = [];
  /** Records finished but waiting for their paint report. */
  private readonly pending = new Map<string, Timer>();
  private answeredInProcess = 0;
  private takes = 0;

  constructor(
    private readonly max = 500,
    private readonly sink?: (t: QuestionTiming) => void,
    private readonly timers: { set(fn: () => void, ms: number): Timer; clear(t: Timer): void } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
  ) {}

  /** Every evaluated interviewer final, question or not. */
  decision(finalAt: number, decidedAt: number): void {
    if (decidedAt < finalAt) return;
    this.decisions.push(decidedAt - finalAt);
    if (this.decisions.length > this.max * 4) this.decisions.splice(0, this.decisions.length - this.max * 4);
  }

  /** Start a take of a question and return its take number — marks and the
   *  outcome carry it, so a stale stream of an earlier take (aborted by a
   *  revision, finishing late) can never write into the new one. */
  begin(t: Omit<QuestionTiming, 'cold' | 'take' | 'category'> & { category?: LatencyCategory }): number {
    const existing = this.timings.get(t.questionId);
    // A revised question restarts its clock but keeps its cold/warm class.
    // Its unfinished earlier take is written as superseded.
    if (existing && !existing.outcome) this.write({ ...existing, outcome: 'superseded' });
    if (existing) this.flushPending(t.questionId, true); // an answered take still waiting for its paint
    const cold = existing ? existing.cold : this.answeredInProcess === 0;
    if (!existing) {
      this.answeredInProcess++;
      this.order.push(t.questionId);
      while (this.order.length > this.max) this.timings.delete(this.order.shift()!);
    }
    const take = ++this.takes;
    this.timings.set(t.questionId, { category: 'general', ...t, cold, take });
    return take;
  }

  /** Patch the current take. Ignored once the take has an outcome — except
   *  the overlay's paint report, which may arrive just after completion —
   *  or when `take` names an older take. One-shot marks keep their first
   *  value. A paint report must NAME this take (the Cue Card learns it from
   *  the take patch): one without a take, or for another take, is dropped
   *  whatever its timestamp; so is one from before this take's first token. */
  mark(questionId: string, patch: Partial<QuestionTiming>, take?: number): void {
    const t = this.timings.get(questionId);
    if (!t || (take !== undefined && t.take !== take)) return;
    if (patch.firstUsefulAt !== undefined && take === undefined) {
      const { firstUsefulAt: _unowned, ...rest } = patch;
      patch = rest;
    }
    const paint = patch.firstUsefulAt;
    if (t.outcome) {
      if (paint === undefined || !this.pending.has(questionId)) return;
      patch = { firstUsefulAt: paint };
    }
    if (paint !== undefined && (t.firstTokenAt === undefined || paint < t.firstTokenAt)) {
      const { firstUsefulAt: _drop, ...rest } = patch;
      patch = rest;
    }
    for (const [k, v] of Object.entries(patch) as [keyof QuestionTiming, never][]) {
      if ((k === 'firstTokenAt' || k === 'firstUsefulAt' || k === 'requestAt' || k === 'dispatchAt') && t[k] !== undefined) continue;
      (t as unknown as Record<string, unknown>)[k] = v;
    }
    if (t.firstUsefulAt !== undefined && this.pending.has(questionId)) this.flushPending(questionId, true);
  }

  /** End the current take. `answered` waits briefly for the paint report;
   *  everything else is written now. */
  finish(questionId: string, outcome: Outcome, patch: Partial<QuestionTiming> = {}, take?: number): void {
    const t = this.timings.get(questionId);
    if (!t || t.outcome || (take !== undefined && t.take !== take)) return;
    Object.assign(t, patch, { outcome });
    if (outcome === 'answered' && t.firstUsefulAt === undefined) {
      this.pending.set(
        questionId,
        this.timers.set(() => this.flushPending(questionId, true), PAINT_GRACE_MS),
      );
      return;
    }
    this.write(t);
  }

  /** A question that will not be answered automatically (a missed card):
   *  in the sample, as unanswered. */
  missed(t: Omit<QuestionTiming, 'cold' | 'take' | 'category' | 'outcome'> & { category?: LatencyCategory; reason: string }): void {
    this.begin(t);
    this.finish(t.questionId, 'missed', { reason: t.reason });
  }

  private flushPending(questionId: string, write: boolean): void {
    const timer = this.pending.get(questionId);
    if (timer === undefined) return;
    this.pending.delete(questionId);
    this.timers.clear(timer);
    const t = this.timings.get(questionId);
    if (write && t) this.write(t);
  }

  private write(t: QuestionTiming): void {
    if (!this.sink) return;
    try {
      this.sink({ ...t });
    } catch {
      /* metrics never break the session */
    }
  }

  get(questionId: string): QuestionTiming | undefined {
    return this.timings.get(questionId);
  }

  all(): QuestionTiming[] {
    return this.order.map((id) => this.timings.get(id)!).filter(Boolean);
  }

  summary(): LatencySummary {
    return summarize(
      this.all().filter((t) => t.outcome && !this.pending.has(t.questionId)),
      this.decisions,
    );
  }

  /** Every evaluated turn's final → decision (ms), oldest first. */
  decisionTimes(): number[] {
    return [...this.decisions];
  }
}

/** The summary of finished records — also used on a `latency.jsonl` file
 *  (metrics/report.ts), so a live run and the in-app summary agree. */
export function summarize(finished: QuestionTiming[], decisions: number[]): LatencySummary {
  const bucket = (rows: QuestionTiming[]): Bucket => {
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    for (const r of rows) if (r.outcome) outcomes[r.outcome]++;
    const stages = {} as Record<Stage, StageSummary>;
    for (const stage of STAGES) {
      const vals = rows.map((r) => stageValue(r, stage)).filter((v): v is number => v !== null);
      stages[stage] = { n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95) };
    }
    return { samples: rows.length, outcomes, stages, endToEnd: endToEnd(rows) };
  };
  const split = (rows: QuestionTiming[]) => ({
    cold: bucket(rows.filter((t) => t.cold)),
    warm: bucket(rows.filter((t) => !t.cold)),
    all: bucket(rows),
  });
  const byCategory = { all: split(finished) } as LatencySummary['byCategory'];
  for (const c of CATEGORIES) byCategory[c] = split(finished.filter((t) => t.category === c));
  return {
    decisions: { n: decisions.length, p50: percentile(decisions, 50), p95: percentile(decisions, 95) },
    byCategory,
  };
}

/** Censored end-to-end percentiles: an unanswered question is +∞. */
export function endToEnd(rows: QuestionTiming[]): EndToEnd {
  const vals = rows.map((r) => stageValue(r, 'finalToFirstUseful') ?? Number.POSITIVE_INFINITY);
  const at = (p: number) => {
    const v = percentile(vals, p);
    return v === null || !Number.isFinite(v) ? null : v;
  };
  return {
    n: vals.length,
    unanswered: vals.filter((v) => !Number.isFinite(v)).length,
    p50: at(50),
    p95: at(95),
    withinTarget: { le1500: vals.filter((v) => v <= 1500).length, le3000: vals.filter((v) => v <= 3000).length },
  };
}
