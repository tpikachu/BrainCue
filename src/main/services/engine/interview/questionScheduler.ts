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
 *     question: a longer copy replaces the queued text (or re-answers the
 *     streaming, answered or missed card — no candidate speech since),
 *     an equal one drops.
 *  4. CONTINUATIONS AND CORRECTIONS SUPERSEDE. "…and how you tested it" or
 *     "Sorry, I meant the second project" within the continuation window of
 *     the last question — before the candidate has started answering —
 *     re-answers THAT question's card with the merged wording. The
 *     scheduler's own in-flight stream of it is aborted first; the stale
 *     tokens never land. A revision never takes the slot from anything else
 *     — a manual Ask or regenerate keeps streaming, and the revision waits
 *     at the head of the queue, on the same card.
 *  5. FRAGMENTS WAIT. An utterance that stops mid-thought ("walk me through
 *     the") is held briefly for its second half and joined with it; if
 *     nothing follows, it is evaluated as it is.
 *  6. NOTHING DISAPPEARS SILENTLY. A distinct question that will not be
 *     answered automatically becomes a visible "missed" card the user can
 *     answer with one tap (↻): the queue overflowed (the OLDEST waiting one),
 *     the user paused with it waiting or still being classified, or the
 *     model recognised it only after the conversation moved on (§8). Every
 *     outcome that lands after a Pause — on time, a late "yes" after a
 *     timeout, a revision routed by rule (a longer repeat, a continuation
 *     or correction), or a revision whose stale answer was still being
 *     cancelled — takes the same path to a missed card, and is never
 *     started automatically, even after Resume. A revision is marked on
 *     its question's own card. A copy that adds no words to a question
 *     already in flight, waiting, answered or shown missed gets no second
 *     card; a longer one is a revision, never discarded. ONE JOB PER
 *     CARD: a revision updates the job the scheduler keeps routing
 *     against (see missRevision), so a follow-up after Resume continues
 *     the wording the card shows, never an older one. Only
 *     STOP drops work — the session is over. While paused, new finals are
 *     not evaluated at all (that is what Pause means).
 *  7. DECISIONS COMMIT IN ARRIVAL ORDER — see evaluate().
 *  8. LATE VERDICTS — see lateVerdict().
 *
 * Supersession, precisely: a turn REVISES an earlier question only when it
 * repeats it (§3) or continues/corrects the LAST question within
 * CONTINUATION_WINDOW_MS, before any candidate speech (§4). The LAST
 * question is the NEWEST one decided — answered, waiting, streaming or
 * shown missed — and only a newer one replaces it (setLast): a queued
 * question starting later, or an older late verdict, never does. It never does
 * when the rules read it as not-a-question (call logistics, backchannel —
 * "Sorry, can you hear me?" is not a correction), nor when it is a complete
 * question of its own after a conjunction ("And why are you interested in
 * this role?"). Everything else is a NEW question in arrival order.
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

/** Why a question became a visible missed card instead of an answer. */
export type MissReason = 'queue-full' | 'paused' | 'late';

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
  /** Surface a question that will not be answered automatically. With
   *  `job.questionId`, mark THAT card; otherwise open one and set
   *  `job.questionId` once it is on screen (may be deferred while a stream
   *  holds the slot — until then a revision may still change `job.text`). */
  missed(job: QuestionJob, why: MissReason): void;
  /** Observability: one record per evaluated final (no text). */
  onDecision?(d: {
    finalAt: number;
    decidedAt: number;
    act: boolean;
    source: Detection['source'] | 'scheduler';
    reason: string;
    outcome: 'answer' | 'queued' | 'superseded' | 'coalesced' | 'duplicate' | 'held' | 'ignored' | 'stale' | 'missed';
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

  /**
   * 7. DECISIONS COMMIT IN ARRIVAL ORDER. Detection runs concurrently (a
   *    slow classifier call never blocks the next turn's detection), but
   *    each turn's decision — queue, coalesce, supersede, drop — is applied
   *    only after every EARLIER turn's decision has been. Otherwise a later
   *    question decided by rule in 0 ms is answered before an earlier one
   *    still with the classifier, whose answer then lands after the
   *    conversation has moved on; and two copies of one question, classified
   *    concurrently, both pass the duplicate check that ran before either
   *    was decided. The repeat / continuation checks therefore run AGAIN at
   *    commit time, against the state every earlier turn left behind.
   *
   *    Cost: a turn waits for earlier turns' detection — bounded by the
   *    classifier timeout (detector.ts CLASSIFY_TIMEOUT_MS). Late verdicts
   *    commit outside this chain (they re-check staleness themselves).
   */
  private commitTail: Promise<void> = Promise.resolve();

  private async evaluate(text: string, tcIds: string[], finalAt: number): Promise<void> {
    const epoch = this.epoch;
    const words = turnWords(text);
    const prior = this.commitTail;
    let release!: () => void;
    this.commitTail = new Promise<void>((r) => (release = r));

    let follow: Promise<void> | null = null;
    try {
      // Skip the model call when, by the state right now, this turn is a
      // repeat or a continuation (re-checked at commit time below).
      const routedNow = !!this.findSame(words, this.deps.now()) || this.continuesByRule(text, this.deps.now());
      const detection = routedNow ? null : this.deps.detect(text, this.deps.recent());
      await prior; // earlier turns' decisions first
      if (this.stopped) {
        this.note(finalAt, false, 'scheduler', 'stopped', 'stale');
        return;
      }
      // Paused (and maybe resumed) while this turn waited: it is not
      // answered — but a question is never dropped silently either (§6).
      if (epoch !== this.epoch) {
        if (!detection) {
          follow = this.settlePausedRevision(text, words, tcIds, finalAt);
          return;
        }
        const d = await detection;
        if (this.stopped) return void this.note(finalAt, d.act, d.source, d.reason, 'stale');
        follow = this.settlePaused(d, text, words, tcIds, finalAt, epoch);
        return;
      }
      follow = this.routeKnown(text, words, tcIds, finalAt);
      if (!follow) {
        const d = await (detection ?? this.deps.detect(text, this.deps.recent()));
        if (this.stopped) {
          this.note(finalAt, d.act, d.source, d.reason, 'stale');
          return;
        }
        if (epoch !== this.epoch) {
          // Paused while THIS turn was being classified (§6, as above).
          follow = this.settlePaused(d, text, words, tcIds, finalAt, epoch);
          return;
        }
        // Re-check after classification too: the streaming answer may have
        // finished (or been superseded) while the classifier ran.
        follow = this.routeKnown(text, words, tcIds, finalAt) ?? this.routeDetected(d, text, words, tcIds, finalAt, epoch);
      }
    } finally {
      release();
    }
    return follow ?? undefined;
  }

  /** The one disposition for a turn whose detection finished in a later
   *  epoch (a pause, maybe followed by resume): never answered, never lost.
   *  A "yes" is a missed card; a timed-out "no" may still turn into a yes
   *  within its late window, and lateVerdict turns THAT into a missed card.
   *  Both go through missNew, which suppresses repeats (§3) — two copies of
   *  one question classified across a pause are one card. */
  private settlePaused(
    d: Detection,
    text: string,
    words: string[],
    tcIds: string[],
    finalAt: number,
    epoch: number,
  ): Promise<void> | null {
    if (d.act) return this.missNew(text, words, tcIds, finalAt, d, 'paused');
    this.note(finalAt, false, d.source, d.reason, 'stale');
    return d.late ? this.lateVerdict(d.late, text, words, tcIds, finalAt, epoch) : null;
  }

  /** The same, for a turn the rules routed as a repeat or a continuation /
   *  correction when it arrived (so it was never classified). A copy that
   *  adds no words is nothing new. Anything else revises a question — a
   *  LONGER repeat ("…and the rollback plan") or a continuation/correction of
   *  the last one — and would be lost silently if dropped: it becomes a
   *  missed card with the revised wording, on that question's own card. */
  private settlePausedRevision(text: string, words: string[], tcIds: string[], finalAt: number): Promise<void> | null {
    const same = this.findSame(words, this.deps.now());
    if (same) {
      if (words.length > same.words.length) this.missRevision(same, text, tcIds, finalAt, 'paused', 'revision');
      else this.note(finalAt, false, 'scheduler', 'epoch-changed', 'duplicate');
      return null;
    }
    const prev = this.last;
    if (prev && (isCorrection(text) || isContinuation(text))) {
      this.missRevision(prev, `${prev.text} ${text}`, tcIds, finalAt, 'paused', isCorrection(text) ? 'correction' : 'continuation');
      return null;
    }
    this.note(finalAt, false, 'scheduler', 'epoch-changed', 'stale');
    return null;
  }

  /**
   * ONE JOB PER CARD. A revision that will not be answered automatically
   * (it arrived across a Pause, or late) updates `target` IN PLACE — the
   * job the scheduler routes later turns against IS the card, so its wording
   * and state always match what the user sees:
   *  - answered, or already missed on screen: the card is marked missed now,
   *    with the revised wording;
   *  - missed but not yet on screen (deferred while a stream holds the slot):
   *    it will show the revised wording;
   *  - still streaming its old wording: that stream finishes on its own
   *    input (the engine captured the text when it started), and the card is
   *    marked missed when it ends (`missAfterRun`);
   *  - waiting in the queue (asked after Resume): it is answered with the
   *    revised wording.
   * A later continuation (after Resume) continues the CURRENT wording.
   */
  private missRevision(target: QuestionJob, text: string, tcIds: string[], finalAt: number, why: MissReason, label: string): void {
    target.text = text;
    target.words = turnWords(text);
    target.transcriptChunkIds = [...target.transcriptChunkIds, ...tcIds];
    target.finalAt = finalAt;
    target.decidedAt = this.deps.now();
    this.setLast(target);
    this.note(finalAt, true, 'scheduler', `missed-${why}-${label}`, 'missed');
    if (target.state === 'answering') return void this.missAfterRun.set(target.seq, why);
    if (target.state === 'queued') return;
    if (target.state === 'missed' && !target.questionId) return;
    this.miss(target, why);
  }

  /** Streaming jobs whose card becomes a missed card when the stream ends. */
  private readonly missAfterRun = new Map<number, MissReason>();

  private continuesByRule(text: string, now: number): boolean {
    return !!this.continuable(now) && (isCorrection(text) || isContinuation(text));
  }

  /** 3–4: a repeat of a question in flight / waiting, or a continuation or
   *  correction of the last one. Null when neither applies. Synchronous up to
   *  the returned promise, so the state change is made inside the commit. */
  private routeKnown(text: string, words: string[], tcIds: string[], finalAt: number): Promise<void> | null {
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
      if (words.length > same.words.length && (same.state === 'answered' || same.state === 'missed')) {
        // A longer repeat of a question already answered (no candidate
        // speech since) or shown missed: the added words are a revision —
        // re-answer THAT card, never drop them as a duplicate.
        return this.supersede(same, text, tcIds, finalAt, 'revision');
      }
      this.note(finalAt, false, 'scheduler', 'duplicate-final', 'duplicate');
      return Promise.resolve();
    }
    // 4. Continuation / correction of the last question, by rule.
    const prev = this.continuable(now);
    if (prev && (isCorrection(text) || isContinuation(text))) {
      return this.supersede(prev, `${prev.text} ${text}`, tcIds, finalAt, isCorrection(text) ? 'correction' : 'continuation');
    }
    return null;
  }

  private routeDetected(
    detection: Detection,
    text: string,
    words: string[],
    tcIds: string[],
    finalAt: number,
    epoch: number,
  ): Promise<void> {
    // 4b. Continuation by the model's judgement.
    if (detection.continuesPrevious) {
      const p = this.continuable(this.deps.now());
      if (p) return this.supersede(p, `${p.text} ${text}`, tcIds, finalAt, 'continuation-model');
    }
    if (detection.act) return this.enqueue(text, words, tcIds, finalAt, detection);
    this.note(finalAt, false, detection.source, detection.reason, 'ignored');
    // The classifier timed out and the rule lean said no — but the model
    // may still answer within its late window.
    return detection.late ? this.lateVerdict(detection.late, text, words, tcIds, finalAt, epoch) : Promise.resolve();
  }

  /** 8. LATE VERDICTS. A late "yes" for a question that was meanwhile asked
   *  again and handled produces nothing (not a distinct question). Otherwise
   *  it is answered — unless the conversation has moved on (a newer
   *  interviewer question, or the candidate already replying) or the session
   *  was paused since: then it becomes a visible missed card, never an
   *  answer arriving out of turn and never silently dropped. "Asked again"
   *  means a copy that adds nothing: a late LONGER copy revises the newest
   *  question's card when that is its shorter copy (no reply yet), and is
   *  otherwise a missed card carrying the added words. */
  private async lateVerdict(
    late: NonNullable<Detection['late']>,
    text: string,
    words: string[],
    tcIds: string[],
    finalAt: number,
    epoch: number,
  ): Promise<void> {
    const v = await late;
    if (!v?.act || this.stopped) return;
    const same = this.findSame(words, this.deps.now());
    if (same && words.length <= same.words.length) {
      // A copy that adds nothing to a question meanwhile handled.
      this.note(finalAt, true, 'model', 'late-verdict-duplicate', 'duplicate');
      return;
    }
    // From here `same`, if any, is a SHORTER copy: this turn's added words
    // ("…and how you handled the rollback") are a revision, never dropped.
    if (epoch !== this.epoch || this.paused) return this.missNew(text, words, tcIds, finalAt, v, 'paused');
    if (same && same === this.last && this.lastCandidateAt <= finalAt) {
      // The newest question IS this one, worded shorter, and the candidate
      // has not replied: revise its card exactly as an on-time longer repeat
      // would (§3) — coalesce if waiting, re-answer if streaming or answered.
      const routed = this.routeKnown(text, words, tcIds, finalAt);
      if (routed) return routed;
    }
    if ((this.last && this.last.finalAt > finalAt) || this.lastCandidateAt > finalAt) {
      return this.missNew(text, words, tcIds, finalAt, v, 'late');
    }
    return this.enqueue(text, words, tcIds, finalAt, v, 'late-model');
  }

  /** A distinct question that will not be answered automatically: a visible
   *  missed card (one tap to answer). When it is the newest question it
   *  becomes `last` — the continuation target (after Resume, "And how you
   *  tested it" continues THIS card, not an older one); an older late result
   *  never takes that from a newer question (setLast). A repeat of
   *  a question already in flight, waiting, answered, or already shown as
   *  missed (within DUPLICATE_WINDOW_MS) is not distinct: no second card. */
  private missNew(
    text: string,
    words: string[],
    tcIds: string[],
    finalAt: number,
    detection: Detection,
    why: MissReason,
  ): Promise<void> {
    const now = this.deps.now();
    // A copy that adds no words. A LONGER one (a correction joined to its
    // question) is a revision the user has not seen — it gets the card.
    const covers = (j: QuestionJob) => sameWords(j.words, words) && words.length <= j.words.length;
    const same = this.findSame(words, now);
    const missedRecently = this.recentMissed.filter(
      (m) => m.state === 'missed' && now - m.decidedAt <= DUPLICATE_WINDOW_MS && sameWords(m.words, words),
    );
    if ((same && covers(same)) || missedRecently.some(covers)) {
      this.note(finalAt, true, detection.source, `missed-${why}-duplicate`, 'duplicate');
      return Promise.resolve();
    }
    // A LONGER copy of a question already shown (or about to be shown) as
    // missed revises THAT card — two copies classified across a Pause are
    // one card. Across a Pause, a longer copy of a question in flight or
    // answered revises its card the same way.
    const prior = missedRecently[0] ?? (why === 'paused' ? same : null);
    if (prior) {
      this.missRevision(prior, text, tcIds, finalAt, why, 'revision');
      return Promise.resolve();
    }
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
      detection: { source: detection.source, reason: detection.reason },
      state: 'queued',
    };
    this.note(finalAt, true, detection.source, `missed-${why}`, 'missed');
    this.setLast(job);
    this.miss(job, why);
    return Promise.resolve();
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
    this.setLast(job);

    // 2. One stream at a time — queue behind whatever holds the slot.
    if (this.active || this.deps.slotBusy()) {
      this.queue.push(job);
      this.note(finalAt, true, detection.source, reason, 'queued');
      while (this.queue.length > QUEUE_MAX) {
        // The oldest waiting NEW question. A revision waiting to re-answer an
        // existing card (supersede behind a manual Ask) is not a new card to
        // give up on — it keeps its place.
        const i = this.queue.findIndex((j) => !j.questionId);
        this.miss(this.queue.splice(i < 0 ? 0 : i, 1)[0], 'queue-full');
      }
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
    this.setLast(target);
    this.note(finalAt, true, 'scheduler', why, 'superseded');
    this.missAfterRun.delete(target.seq); // it is answered with this wording instead
    if (target.state === 'queued') return this.wait(target);
    // A missed card not on screen yet (deferred while a stream holds the
    // slot): it will appear with this wording, one tap to answer. Starting
    // it now would race the deferred surfacing for the same card.
    if (target.state === 'missed' && !target.questionId) return Promise.resolve();
    // Answering or answered: take the slot back for this question.
    if (target.state === 'answering') {
      // The aborted run resolves and must NOT finish the job or pump —
      // `rerun` marks it, then the job runs again below. While the abort
      // settles the job is in neither the queue nor the slot, so Pause and
      // Stop cannot see it: the epoch is re-checked after the await.
      const epoch = this.epoch;
      target.state = 'queued';
      this.rerunning.add(target.seq);
      this.deps.abortActive();
      await this.activeRun;
      this.rerunning.delete(target.seq);
      if (this.active === target) this.active = null;
      if (this.stopped) return void this.finish(target, 'dropped');
      if (epoch !== this.epoch) {
        // Paused (maybe resumed) meanwhile: never started automatically —
        // a missed card with the revised wording, on its own card (§6).
        this.note(finalAt, true, 'scheduler', `missed-paused-${why}`, 'missed');
        this.miss(target, 'paused');
        this.pump();
        return;
      }
    }
    if (this.stopped) return void this.finish(target, 'dropped');
    if (this.active || this.deps.slotBusy()) {
      // Something else holds the slot — a queued question that already
      // started, or a manual Ask / regenerate the scheduler does not own:
      // answer the revision next, on the same card, rather than abort an
      // unrelated answer.
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
    this.setLast(job);
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
    const missWhy = this.missAfterRun.get(job.seq);
    this.missAfterRun.delete(job.seq);
    if (missWhy && !this.stopped) this.miss(job, missWhy); // revised while it streamed (missRevision)
    else this.finish(job, 'answered');
    this.pump();
  }

  /** `last` is the NEWEST question — the continuation target and the
   *  "has the conversation moved on" reference. Only a question at least as
   *  new as the current one replaces it: a queued question starting late, or
   *  an older late verdict, never takes it from a newer one. */
  private setLast(job: QuestionJob): void {
    if (!this.last || this.last === job || job.finalAt >= this.last.finalAt) this.last = job;
  }

  private pump(): void {
    if (this.stopped || this.paused || this.active || this.deps.slotBusy()) return;
    const next = this.queue.shift();
    if (next) void this.run(next);
  }

  /** Cards surfaced as missed, for missNew's repeat check. Pruned to the
   *  duplicate window. */
  private recentMissed: QuestionJob[] = [];

  private miss(job: QuestionJob, why: MissReason): void {
    const now = this.deps.now();
    this.recentMissed = this.recentMissed.filter((m) => now - m.decidedAt <= DUPLICATE_WINDOW_MS);
    this.recentMissed.push(job);
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
    // A missed card may be continued: on screen, the follow-up re-answers
    // it with the current wording; not yet shown, it takes the joined
    // wording (supersede). A dropped one may not.
    if (!p || p.state === 'dropped') return null;
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
