/**
 * Live-interview latency instrumentation (docs/06-OPENAI-SERVICE.md §Latency).
 *
 * Four stages, measured separately so a regression points at its cause:
 *
 *   speechEnd → final       the transcriber's endpoint wait
 *   final → decision        question detection (rules / classifier)
 *   decision → grounded     retrieval + memory recall ready
 *   final → firstVisible    the answer's first words PAINTED in the Cue Card
 *                           (reported back by the overlay after a frame —
 *                           not the provider's first event)
 *
 * Timestamps are wall-clock ms from one machine: main and the overlay share
 * `Date.now()`. No transcript or answer text is ever recorded here.
 */

export type Stage = 'speechToFinal' | 'finalToDecision' | 'decisionToGrounded' | 'finalToFirstToken' | 'finalToFirstVisible';

export const STAGES: Stage[] = ['speechToFinal', 'finalToDecision', 'decisionToGrounded', 'finalToFirstToken', 'finalToFirstVisible'];

export interface QuestionTiming {
  questionId: string;
  sessionId: string;
  speechEndAt?: number;
  finalAt: number;
  decidedAt?: number;
  groundedAt?: number;
  firstTokenAt?: number;
  firstVisibleAt?: number;
  /** First answer of this app process — connection setup not yet paid. */
  cold: boolean;
  detection?: string;
  prefetched?: boolean;
  /** The route that produced the first visible token (the answering
   *  attempt) — seeded at dispatch, re-marked by the attempt that answers. */
  provider?: string;
  model?: string;
  /** Attempts that failed before the answering one (same-provider failover). */
  failedAttempts?: number;
}

export interface StageSummary {
  n: number;
  p50: number | null;
  p95: number | null;
}

export type LatencySummary = Record<'cold' | 'warm' | 'all', Record<Stage, StageSummary>>;

/** Nearest-rank percentile over a sorted copy. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

function stageValue(t: QuestionTiming, stage: Stage): number | null {
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined && b >= a ? b - a : null);
  switch (stage) {
    case 'speechToFinal':
      return d(t.speechEndAt, t.finalAt);
    case 'finalToDecision':
      return d(t.finalAt, t.decidedAt);
    case 'decisionToGrounded':
      return d(t.decidedAt, t.groundedAt);
    case 'finalToFirstToken':
      return d(t.finalAt, t.firstTokenAt);
    case 'finalToFirstVisible':
      return d(t.finalAt, t.firstVisibleAt);
  }
}

/** Bounded in-memory record of recent questions plus every detection
 *  decision (questions or not — detection latency is paid on every turn). */
export class LatencyRecorder {
  private readonly timings = new Map<string, QuestionTiming>();
  private readonly order: string[] = [];
  private readonly decisions: number[] = [];
  private answeredInProcess = 0;

  constructor(
    private readonly max = 500,
    private readonly sink?: (t: QuestionTiming) => void,
  ) {}

  /** Every evaluated interviewer final, question or not. */
  decision(finalAt: number, decidedAt: number): void {
    if (decidedAt < finalAt) return;
    this.decisions.push(decidedAt - finalAt);
    if (this.decisions.length > this.max * 4) this.decisions.splice(0, this.decisions.length - this.max * 4);
  }

  begin(t: Omit<QuestionTiming, 'cold'>): void {
    const existing = this.timings.get(t.questionId);
    // A superseded/regenerated question restarts its clock but keeps its
    // cold/warm class.
    const cold = existing ? existing.cold : this.answeredInProcess === 0;
    if (!existing) {
      this.answeredInProcess++;
      this.order.push(t.questionId);
      while (this.order.length > this.max) this.timings.delete(this.order.shift()!);
    }
    this.timings.set(t.questionId, { ...t, cold });
  }

  mark(questionId: string, patch: Partial<QuestionTiming>): void {
    const t = this.timings.get(questionId);
    if (!t) return;
    const firstVisibleNow = patch.firstVisibleAt !== undefined && t.firstVisibleAt === undefined;
    // First value wins for one-shot marks (first token / first visible).
    for (const [k, v] of Object.entries(patch) as [keyof QuestionTiming, never][]) {
      if ((k === 'firstTokenAt' || k === 'firstVisibleAt') && t[k] !== undefined) continue;
      (t as unknown as Record<string, unknown>)[k] = v;
    }
    if (firstVisibleNow && this.sink) {
      try {
        this.sink({ ...t });
      } catch {
        /* metrics never break the session */
      }
    }
  }

  get(questionId: string): QuestionTiming | undefined {
    return this.timings.get(questionId);
  }

  all(): QuestionTiming[] {
    return this.order.map((id) => this.timings.get(id)!).filter(Boolean);
  }

  summary(): LatencySummary {
    const build = (filter: (t: QuestionTiming) => boolean): Record<Stage, StageSummary> => {
      const rows = this.all().filter(filter);
      const out = {} as Record<Stage, StageSummary>;
      for (const stage of STAGES) {
        const vals = rows.map((r) => stageValue(r, stage)).filter((v): v is number => v !== null);
        out[stage] = { n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95) };
      }
      return out;
    };
    const all = build(() => true);
    // Detection latency counts every evaluated turn, not only questions.
    all.finalToDecision = {
      n: this.decisions.length,
      p50: percentile(this.decisions, 50),
      p95: percentile(this.decisions, 95),
    };
    return { cold: build((t) => t.cold), warm: build((t) => !t.cold), all };
  }
}
