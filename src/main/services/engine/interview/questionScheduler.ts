import { sameWords, turnWords } from '../echoGuard';
import { assessUtterance, isContinuation, isCorrection } from './questionHeuristics';
import type { Detection } from './detector';
import type { ClassifierTurn } from '../../openai/questions';

/**
 * The interview question scheduler — what happens to an interviewer turn
 * between "the transcriber finalized it" and "an answer card streams".
 *
 * v1 had no scheduler: while an answer streamed, `onTranscriptFinal`
 * returned early, so a second question asked during the first answer was
 * transcribed and never even evaluated. A question split across two
 * transcription segments became two half-questions (or none), and a
 * repeated final answered the same thing twice.
 *
 * The policy, explicitly (docs/06-OPENAI-SERVICE.md §Scheduling):
 *
 *  1. DETECTION NEVER STOPS. Every interviewer final is evaluated, whether or
 *     not an answer is streaming.
 *  2. ONE ANSWER STREAMS AT A TIME. A distinct question detected while one
 *     streams (or while a manual Ask / regenerate holds the slot) is QUEUED
 *     and answered as soon as the slot frees — FIFO, so the cards read in
 *     the order the questions were asked.
 *  3. REVISIONS COALESCE. A final that repeats the in-flight or queued
 *     question (a duplicate final, a transcriber revision) is not a new
 *     question: a longer copy replaces the queued text, an equal one drops.
 *  4. CONTINUATIONS AND CORRECTIONS SUPERSEDE. "…and how you tested it" or
 *     "Sorry, I meant the second project" within the continuation window of
 *     the last question — before the candidate has started answering —
 *     re-answers THAT question's card with the merged wording. An in-flight
 *     stream is aborted first; the stale tokens never land.
 *  5. FRAGMENTS WAIT. An utterance that stops mid-thought ("walk me through
 *     the") is held briefly for its second half and joined with it; if
 *     nothing follows, it is evaluated as it is.
 *  6. NOTHING DISAPPEARS SILENTLY. A question that cannot be answered — the
 *     queue is full, or the user paused with questions waiting — becomes a
 *     visible card the user can answer with one tap (↻).
 *
 * Interim transcripts never reach here; only finals do (interim text may
 * prefetch grounding, never create a card).
 *
 * Pure orchestration: the EngineSession supplies detection, answering and
 * the missed-card surface, so this file is testable with fakes and a clock.
 */

/** A later utterance within this window of a question, with no candidate
 *  speech in between, may continue or correct it. */
export const CONTINUATION_WINDOW_MS = 8000;
/** A repeated final within this window is the same question, not a new one. */
export const DUPLICATE_WINDOW_MS = 20000;
/** How long a dangling fragment waits for the rest of the sentence. Short —
 *  the transcriber already waited for silence before it endpointed. */
export const FRAGMENT_HOLD_MS = 1200;
/** Distinct questions waiting behind the streaming answer. Past this the
 *  oldest waiting one becomes a "missed" card instead of a late answer. */
export const QUEUE_MAX = 3;

export interface QuestionJob {
  /** Stable for the life of the job — revisions keep it. */
  seq: number;
  text: string;
  words: string[];
  type: string;
  confidence: number;
  strategy: string;
  transcriptChunkIds: string[];
  /** When the (last part of the) question was finalized — latency anchor. */
  finalAt: number;
  /** When it was detected. */
  decidedAt: number;
  detection: Pick<Detection, 'source' | 'reason'>;
  /** The question row/card once answering began; a superseding revision
   *  re-answers on the same row. */
  questionId?: string;
  state: 'queued' | 'answering' | 'answered' | 'missed' | 'dropped';
}

export interface SchedulerDeps {
  detect(text: string, recent: ClassifierTurn[]): Promise<Detection>;
  recent(): ClassifierTurn[];
  /** Register (or, with `job.questionId`, re-use) the question row and stream
   *  its answer. Resolves when the stream completes OR is aborted. Must set
   *  `job.questionId` before its first await. */
  answer(job: QuestionJob): Promise<void>;
  /** Abort whatever answer is streaming now. */
  abortActive(): void;
  /** Is an answer stream (any — manual Ask, regenerate) holding the slot? */
  slotBusy(): boolean;
  /** Surface a question that will not be answered automatically. */
  missed(job: QuestionJob, why: 'queue-full' | 'paused'): void;
  /** Observability: one record per evaluated final (no text). */
  onDecision?(d: {
    finalAt: number;
    decidedAt: number;
    act: boolean;
    source: Detection['source'] | 'scheduler';
    reason: string;
    outcome: 'answer' | 'queued' | 'superseded' | 'coalesced' | 'duplicate' | 'held' | 'ignored' | 'stale';
  }): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

interface Held {
  text: string;
  tcIds: string[];
  finalAt: number;
  timer: unknown;
  resolve: () => void;
}

export class QuestionScheduler {
  private active: QuestionJob | null = null;
  private readonly queue: QuestionJob[] = [];
  /** The most recent question decided (active, queued or answered). */
  private last: QuestionJob | null = null;
  private held: Held | null = null;
  private lastCandidateAt = 0;
  private seq = 0;
  /** Bumped by stop/pause: work that wakes after it is stale. */
  private epoch = 0;
  private stopped = false;
  private paused = false;
  /** Resolvers waiting for a job to finish (onRemoteFinal awaits its job). */
  private readonly waiters = new Map<number, (() => void)[]>();

  constructor(private readonly deps: SchedulerDeps) {}

  get pending(): readonly QuestionJob[] {
    return this.queue;
  }

  get current(): QuestionJob | null {
    return this.active;
  }

  /** The candidate spoke: the interviewer's next words are a new question,
   *  not a continuation of the last one. */
  onCandidateTurn(at = this.deps.now()): void {
    this.lastCandidateAt = at;
  }

  /**
   * One finalized interviewer turn. Resolves once this turn is settled —
   * ignored, coalesced, or (when it became a question) answered. Never throws.
   */
  async onRemoteFinal(text: string, transcriptChunkId: string, finalAt = this.deps.now()): Promise<void> {
    if (this.stopped || this.paused || !text.trim()) return;
    let tcIds = [transcriptChunkId];

    // A held fragment and this turn are one utterance.
    if (this.held) {
      const h = this.held;
      this.held = null;
      this.deps.clearTimer(h.timer);
      text = `${h.text} ${text}`;
      tcIds = [...h.tcIds, ...tcIds];
      h.resolve();
    }

    const assessment = assessUtterance(text);
    if (assessment.verdict === 'fragment') {
      return new Promise<void>((resolve) => {
        const timer = this.deps.setTimer(() => {
          const h = this.held;
          if (!h || h.timer !== timer) return;
          this.held = null;
          void this.evaluate(h.text, h.tcIds, h.finalAt).then(resolve, resolve);
        }, FRAGMENT_HOLD_MS);
        this.held = { text, tcIds, finalAt, timer, resolve };
        this.note(finalAt, false, 'scheduler', 'fragment-held', 'held');
      });
    }
    return this.evaluate(text, tcIds, finalAt);
  }

  /** Pause: nothing is evaluated; questions still waiting become missed cards
   *  (visible, one tap to answer) rather than answers arriving after Resume
   *  to questions asked minutes ago. */
  pause(): void {
    this.paused = true;
    this.epoch++;
    this.dropHeld();
    for (const job of this.queue.splice(0)) this.miss(job, 'paused');
  }

  resume(): void {
    this.paused = false;
  }

  /** Session over: cancel timers and forget everything. */
  stop(): void {
    this.stopped = true;
    this.epoch++;
    this.dropHeld();
    for (const job of this.queue.splice(0)) this.finish(job, 'dropped');
  }

  /** The answer slot freed (a manual Ask / regenerate finished) — start the
   *  next waiting question, if any. */
  slotFreed(): void {
    this.pump();
  }

  // ---- internals ----

  private async evaluate(text: string, tcIds: string[], finalAt: number): Promise<void> {
    const epoch = this.epoch;
    const words = turnWords(text);
    const now = this.deps.now();

    // 3. Repeats of a question already in flight or waiting.
    const same = this.findSame(words, now);
    if (same) {
      if (words.length > same.words.length && (same.state === 'queued' || same.state === 'answering')) {
        if (same.state === 'queued') {
          same.text = text;
          same.words = words;
          same.transcriptChunkIds.push(...tcIds);
          this.note(finalAt, true, 'scheduler', 'revision-of-queued', 'coalesced');
          return this.wait(same);
        }
        // A longer revision of the streaming question: re-answer it.
        return this.supersede(same, text, tcIds, finalAt, 'revision');
      }
      this.note(finalAt, false, 'scheduler', 'duplicate-final', 'duplicate');
      return;
    }

    // 4. Continuation / correction of the last question, by rule.
    const prev = this.continuable(now);
    if (prev && (isCorrection(text) || isContinuation(text))) {
      return this.supersede(prev, `${prev.text} ${text}`, tcIds, finalAt, isCorrection(text) ? 'correction' : 'continuation');
    }

    const detection = await this.deps.detect(text, this.deps.recent());
    if (epoch !== this.epoch || this.stopped) {
      this.note(finalAt, detection.act, detection.source, detection.reason, 'stale');
      return;
    }

    // 4b. …or by the model's judgement.
    if (detection.continuesPrevious) {
      const p = this.continuable(this.deps.now());
      if (p) return this.supersede(p, `${p.text} ${text}`, tcIds, finalAt, 'continuation-model');
    }

    if (!detection.act) {
      this.note(finalAt, false, detection.source, detection.reason, 'ignored');
      // The classifier timed out and the rule lean said no — but the model
      // may still answer within its late window. A late "yes" is acted on
      // unless the conversation has moved on: a newer interviewer question,
      // or the candidate already responding.
      if (detection.late) {
        const late = await detection.late;
        if (!late?.act || epoch !== this.epoch || this.stopped) return;
        if ((this.last && this.last.finalAt > finalAt) || this.lastCandidateAt > finalAt) {
          this.note(finalAt, true, 'model', 'late-verdict-moot', 'stale');
          return;
        }
        return this.enqueue(text, words, tcIds, finalAt, late, 'late-model');
      }
      return;
    }
    return this.enqueue(text, words, tcIds, finalAt, detection);
  }

  /** A detected question becomes a job: answered now, or queued behind the
   *  stream that holds the slot. */
  private async enqueue(
    text: string,
    words: string[],
    tcIds: string[],
    finalAt: number,
    detection: Detection,
    reasonOverride?: string,
  ): Promise<void> {
    const reason = reasonOverride ?? detection.reason;
    const job: QuestionJob = {
      seq: ++this.seq,
      text,
      words,
      type: detection.type,
      confidence: detection.confidence,
      strategy: detection.strategy,
      transcriptChunkIds: tcIds,
      finalAt,
      decidedAt: this.deps.now(),
      detection: { source: detection.source, reason },
      state: 'queued',
    };
    this.last = job;

    // 2. One stream at a time — queue behind whatever holds the slot.
    if (this.active || this.deps.slotBusy()) {
      this.queue.push(job);
      this.note(finalAt, true, detection.source, reason, 'queued');
      while (this.queue.length > QUEUE_MAX) this.miss(this.queue.shift()!, 'queue-full');
      return this.wait(job);
    }
    this.note(finalAt, true, detection.source, reason, 'answer');
    await this.run(job);
  }

  /** Re-answer `target` with new wording on the same card. */
  private async supersede(
    target: QuestionJob,
    text: string,
    tcIds: string[],
    finalAt: number,
    why: string,
  ): Promise<void> {
    target.text = text;
    target.words = turnWords(text);
    target.transcriptChunkIds.push(...tcIds);
    target.finalAt = finalAt;
    target.decidedAt = this.deps.now();
    this.note(finalAt, true, 'scheduler', why, 'superseded');
    if (target.state === 'queued') return this.wait(target);
    // Answering or answered: take the slot back for this question.
    if (target.state === 'answering') {
      // The aborted run resolves and must NOT finish the job or pump —
      // `rerun` marks it, then the job runs again below.
      target.state = 'queued';
      this.rerunning.add(target.seq);
      this.deps.abortActive();
      await this.activeRun;
      this.rerunning.delete(target.seq);
    }
    if (this.stopped) return;
    if (this.active && this.active !== target) {
      // Something else streams (a queued question already started): answer
      // the revision next rather than abort an unrelated answer.
      target.state = 'queued';
      this.queue.unshift(target);
      return this.wait(target);
    }
    await this.run(target);
  }

  private readonly rerunning = new Set<number>();
  private activeRun: Promise<void> = Promise.resolve();

  private async run(job: QuestionJob): Promise<void> {
    this.active = job;
    job.state = 'answering';
    this.last = job;
    const runPromise = (async () => {
      try {
        await this.deps.answer(job);
      } catch {
        /* surfaced by the session (error banner); the queue must move on */
      }
    })();
    this.activeRun = runPromise;
    await runPromise;
    if (this.rerunning.has(job.seq)) return; // superseded mid-stream; the supersede re-runs it
    if (this.active === job) this.active = null;
    this.finish(job, 'answered');
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.paused || this.active || this.deps.slotBusy()) return;
    const next = this.queue.shift();
    if (next) void this.run(next);
  }

  private miss(job: QuestionJob, why: 'queue-full' | 'paused'): void {
    try {
      this.deps.missed(job, why);
    } catch {
      /* surface failure must not break the queue */
    }
    this.finish(job, 'missed');
  }

  private finish(job: QuestionJob, state: QuestionJob['state']): void {
    job.state = state;
    const ws = this.waiters.get(job.seq);
    this.waiters.delete(job.seq);
    ws?.forEach((r) => r());
  }

  private wait(job: QuestionJob): Promise<void> {
    if (job.state !== 'queued' && job.state !== 'answering') return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(job.seq) ?? [];
      list.push(resolve);
      this.waiters.set(job.seq, list);
    });
  }

  private findSame(words: string[], now: number): QuestionJob | null {
    if (words.length === 0) return null;
    const candidates = [this.active, ...this.queue, this.last].filter((j): j is QuestionJob => !!j);
    for (const j of candidates) {
      if (now - j.decidedAt > DUPLICATE_WINDOW_MS) continue;
      if (j.state === 'answered' && this.lastCandidateAt > j.decidedAt) continue; // asked again after an answer
      if (sameWords(j.words, words)) return j;
    }
    return null;
  }

  /** The last question, if a new utterance may still continue it. */
  private continuable(now: number): QuestionJob | null {
    const p = this.last;
    if (!p || p.state === 'missed' || p.state === 'dropped') return null;
    if (now - p.finalAt > CONTINUATION_WINDOW_MS) return null;
    if (this.lastCandidateAt > p.finalAt) return null;
    return p;
  }

  private dropHeld(): void {
    if (!this.held) return;
    this.deps.clearTimer(this.held.timer);
    this.held.resolve();
    this.held = null;
  }

  private note(
    finalAt: number,
    act: boolean,
    source: Detection['source'] | 'scheduler',
    reason: string,
    outcome: Parameters<NonNullable<SchedulerDeps['onDecision']>>[0]['outcome'],
  ): void {
    this.deps.onDecision?.({ finalAt, decidedAt: this.deps.now(), act, source, reason, outcome });
  }
}
