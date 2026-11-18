import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import {
  emitAmbientContribution,
  emitContributionContext,
  emitContributionDelta,
  emitContributionDone,
  emitContributionFollowup,
  emitContributionMeta,
  emitContributionOpen,
  emitContributionReset,
  emitContributionTitle,
} from '../../ipc/contributionBridge';
import { retryRouteAfterModelError, taskRoute } from '../../providers/taskRoute';
import { providerErrorKind } from '../../providers/errorKind';
import { QuestionScheduler, type QuestionJob, type MissReason } from './interview/questionScheduler';
import { assessUtterance } from './interview/questionHeuristics';
import type { Detection } from './interview/detector';
import { latency } from './metrics/latencyStore';
import { latencyCategory, type Outcome, type QuestionTiming } from './metrics/latency';
import type { ClassifierTurn } from '../openai/questions';
import { normalizeProviderError } from '../../providers/normalizeError';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { log } from '../security/logger';
import { markRecalled, recallMemories } from '../memory/recall';
import { ground } from './grounding';
import { enginePersistence as persist } from './persistence/enginePersistence';
import { EchoGuard, sameWords, turnWords } from './echoGuard';
import { evaluateTurnHeuristics } from './trigger/meetingHeuristics';
import type { AnswerRoute, RetrievedChunk, RetrievedMemory } from '@shared/types';
import { summonedPolicy } from './trigger/summonedPolicy';
import type { AudioSource, Speaker } from '@shared/types';
import type { RealtimeSttSession } from '../../providers/types';
import { ConversationContext } from './interview/conversationContext';
import type { ContextEvent, TurnTiming } from './contextEvent';
import type { AmbientPolicy, ModeDefinition, RuntimeSettings } from './modeDefinition';

/** Everything an answer is grounded on, gathered in parallel: documents and
 *  approved memory. Each one's own run time is kept for the latency record. */
interface Gathered {
  chunks: RetrievedChunk[];
  memories: RetrievedMemory[];
  retrievalMs: number;
  recallMs: number;
  /** Which of the two had to rank lexically (embedding late or failed). */
  lexical: ('documents' | 'memory')[];
}

/** A question we answered, kept so the Cue Card can re-generate it (e.g. after
 *  toggling length/format/pronunciation) by reusing the SAME question row — no
 *  duplicate question/transcript line. */
interface LastQuestion {
  questionId: string;
  text: string;
  /** Classifier type ('behavioral', 'technical', …) — regenerate re-sends it. */
  type: string;
}


/**
 * One live conversation session: the generic flow
 * ContextEvent → trigger decision → grounding → generation → contribution →
 * persistence/surfaces, owned here; everything mode-specific comes in through
 * the ModeDefinition. This is the v1 interview pipeline EXTRACTED — the
 * concurrency rules (answer-slot ownership, abort ordering, stale-followup
 * guards) are transplanted verbatim and pinned by sessionManager.parity.test.
 */
export class EngineSession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly packId: string | null;
  readonly mode: ModeDefinition;
  /** Mock rehearsal — no transcriber; the session row is deleted at stop. */
  readonly ephemeral: boolean;

  settings: RuntimeSettings;
  paused = false;
  busy = false; // a chunk is currently being processed (chunked fallback path)
  answering = false; // an answer is currently being generated (avoid overlap)
  answerAbort: AbortController | null = null; // cancels the in-flight answer (clear/regen)
  lastQuestion: LastQuestion | null = null;
  /** Everything this session has heard (both speakers) and suggested,
   *  bounded — rendered per answer as a snapshot (recent turns verbatim, a
   *  traceable record of earlier exchanges, recalled older turns, and
   *  BrainCue's suggestions kept apart from what was said). Per instance, so
   *  another session's conversation can never reach this one's answers.
   *  Prompt-only: the DB rows remain the record. */
  /** Whole turns in memory (bounded); past the bound, recall searches THIS
   *  session's persisted transcript — never another session's. */
  readonly context = new ConversationContext(() =>
    persist
      .sessionTimeline(this.sessionId)
      .turns.map((t) => ({ role: t.speaker === this.mode.remoteSpeaker ? ('interviewer' as const) : ('candidate' as const), text: t.text, at: t.at })),
  );
  // Coding sessions default to "listen but don't auto-answer" so a generated coding
  // answer isn't replaced when the remote speaker talks. We keep transcribing and
  // remember the last utterance so toggling answering on can answer it.
  suppressAnswers = false;
  pendingQuestionText: string | null = null;
  /** One live transcriber per captured stream (engine.begin opens them from
   *  the activity's capture plan). Rehearsals hold none. */
  readonly transcribers: Partial<Record<AudioSource, RealtimeSttSession>> = {};
  /** The stream whose turns may trigger a contribution (the call, or the mic
   *  for solo activities). Informational — the speaker on each final decides. */
  triggerSource: AudioSource = 'system';
  /** Latest RMS level per stream — the Cue Card meter shows the louder one. */
  readonly levels: Record<AudioSource, number> = { system: 0, mic: 0 };
  /** Drops the microphone's copy of what the call just said (laptop
   *  speakers → the mic hears the call). See echoGuard.ts. */
  /** Grounding and memory recall started on the INTERIM transcript, before
   *  the turn's final (see prefetchGrounding). Consumed by the next
   *  generateContribution whose question says the same words; otherwise
   *  discarded. */
  private prefetch: { words: string[]; promise: Promise<Gathered> } | null = null;
  private readonly echo = new EchoGuard({
    onDrop: (words) => {
      // Word count only — transcript text never goes to the log.
      log.info(`echo guard: dropped the microphone's copy of a call turn (${words} words)`);
      // The UI showed this turn as the user's in-flight line; it will never
      // become a final, so tell both windows to drop that line.
      broadcast(EVENTS.transcriptDelta, { text: '', isFinal: false, speaker: this.mode.localSpeaker, clear: true });
    },
  });
  /** Ambient trigger state (Meeting/Companion) — per-session cooldowns/
   *  dedupe/pending questions. Null for Q&A modes (interview). */
  readonly ambientPolicy: AmbientPolicy | null;
  /** Interview (Q&A modes): every interviewer final goes through the
   *  scheduler — detection keeps running while an answer streams, distinct
   *  questions queue, revisions coalesce. Null for ambient modes. */
  readonly scheduler: QuestionScheduler | null;
  /** Recent interviewer turns with their transcript row — what the manual
   *  "Answer that" button answers when detection missed. */
  private readonly remoteTurns: { text: string; tcId: string; at: number }[] = [];
  /** Speech-end time (and which anchor it is) per transcript row, for the
   *  latency record. */
  private readonly speechEnds = new Map<string, { at: number; source?: TurnTiming['speechEndSource'] }>();
  /** Missed-question cards waiting for the answer slot to free. */
  private readonly pendingMissed: { job: QuestionJob; why: MissReason }[] = [];

  /** Set on teardown/replacement: an in-flight classify/stream/prediction that
   *  wakes up afterwards must act as if the old module-level `live` changed. */
  private stopped = false;
  lastLevelAt = 0; // throttle the Cue Card audio-level meter broadcasts
  // Follow-up predictions are fire-and-forget; a regenerate can leave an OLD
  // answer's prediction in flight. Each generation bumps its question's
  // generation, and a prediction only lands if its generation is still current —
  // a stale follow-up must never annotate (or persist onto) a newer answer.
  private followupGeneration = new Map<string, number>();

  constructor(opts: {
    sessionId: string;
    profileId: string;
    packId: string | null;
    mode: ModeDefinition;
    settings: RuntimeSettings;
    ephemeral: boolean;
    /** Hard session budget in cents (companion cost governance). */
    budgetCents?: number | null;
    /** Explicit start-time companion posture. */
    companionPresence?: string;
  }) {
    this.sessionId = opts.sessionId;
    this.profileId = opts.profileId;
    this.packId = opts.packId;
    this.mode = opts.mode;
    this.settings = opts.settings;
    this.ephemeral = opts.ephemeral;
    this.ambientPolicy =
      opts.mode.ambient?.createPolicy(opts.settings.presence, {
        sessionId: opts.sessionId,
        profileId: opts.profileId,
        packId: opts.packId,
        budgetCents: opts.budgetCents,
        companionPresence: opts.companionPresence,
      }) ?? null;
    this.scheduler = opts.mode.ambient ? null : this.createScheduler();
  }

  private createScheduler(): QuestionScheduler {
    return new QuestionScheduler({
      detect: (text, recent) => this.detect(text, recent),
      recent: () => this.recentForClassifier(),
      answer: (job) => this.answerScheduled(job),
      abortActive: () => this.abortScheduled(),
      slotBusy: () => this.answering,
      missed: (job, why) => this.surfaceMissed(job, why),
      onDecision: (d) => {
        latency.decision(d.finalAt, d.decidedAt);
        // Outcome + timing only — never the words.
        log.info(`question detection: ${d.outcome} (${d.source}/${d.reason}) in ${d.decidedAt - d.finalAt} ms`);
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
  }

  /** The mode's trigger, as a scheduler detection. Never throws. */
  private async detect(text: string, recent: ClassifierTurn[]): Promise<Detection> {
    try {
      const d = await this.mode.trigger.evaluate(text, { recent });
      return (
        d.detection ?? {
          act: d.act && !!d.question,
          type: (d.question?.type ?? 'behavioral') as Detection['type'],
          confidence: d.question?.confidence ?? 0,
          strategy: d.question?.strategy ?? '',
          source: 'model',
          reason: d.reason,
          continuesPrevious: false,
        }
      );
    } catch (e) {
      log.error('question detection failed', e);
      return {
        act: false,
        type: 'behavioral',
        confidence: 0,
        strategy: '',
        source: 'fallback',
        reason: 'detector-error',
        continuesPrevious: false,
      };
    }
  }

  /** The last few turns, speaker-labelled, for the classifier. Only what was
   *  SAID — BrainCue's own suggestions are not part of the conversation. */
  private recentForClassifier(): ClassifierTurn[] {
    return this.context.recentForClassifier(4);
  }

  /** Resume: restore this session's own turns and answers (oldest first, in
   *  transcriptOrder). Capture order continues after the restored turns, so
   *  everything said after Resume sorts after everything said before it. */
  hydrate(
    turns: { speaker: Speaker; text: string; at: number; seq?: number | null }[],
    answers: { questionId: string; question: string; answer: string; at: number }[],
  ): void {
    turns.forEach((t, i) => (this.captureOrder = Math.max(this.captureOrder, t.seq ?? 0, i + 1)));
    this.context.hydrate(
      turns.map((t, i) => ({
        role: t.speaker === this.mode.remoteSpeaker ? ('interviewer' as const) : ('candidate' as const),
        text: t.text,
        at: t.at,
        order: i + 1, // their position in transcriptOrder (seq where recorded, insertion otherwise)
      })),
      answers,
    );
  }

  /** Capture order of finals within this session (persisted as capture_seq). */
  private captureOrder = 0;

  /** Pause/resume — the scheduler turns waiting questions into missed cards. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.scheduler?.pause();
    else this.scheduler?.resume();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Abort in-flight work and release every transcriber. Idempotent. */
  teardown(): void {
    this.scheduler?.stop();
    this.answerAbort?.abort();
    this.prefetch = null;
    this.echo.flush(); // held own turns are the user's last words — keep them
    for (const source of Object.keys(this.transcribers) as AudioSource[]) {
      this.transcribers[source]?.stop();
      delete this.transcribers[source];
    }
    this.stopped = true;
  }

  /** Normalized entry point for sources. Control events are handled by the
   *  engine (they affect which session is live); everything else lands here. */
  async handleEvent(ev: ContextEvent): Promise<void> {
    switch (ev.kind) {
      case 'transcript_final':
        return this.onTranscriptFinal(ev.text, ev.speaker, ev.timing);
      case 'direct_ask':
        return this.directAsk(ev.text);
      default:
        // transcript_delta streams straight to the overlay; screen/clipboard
        // still enter via services/capture (see contextEvent.ts).
        return;
    }
  }

  /** Persist a finalized transcript turn, run the trigger policy, and (when it
   *  says act) generate the contribution.
   *
   *  Every turn — whoever said it — is persisted, broadcast to the transcript
   *  and remembered in the in-session history. But only the REMOTE speaker's
   *  turns (the call; the user themselves in a solo activity) go on to the
   *  trigger / ambient policy: the user's own microphone turns are what they
   *  said, never a question to answer. `speaker` defaults to the remote one so
   *  every v1 caller keeps its behaviour. */
  async onTranscriptFinal(
    text: string,
    speaker: Speaker = this.mode.remoteSpeaker,
    timing: TurnTiming = {},
  ): Promise<void> {
    if (!text || this.stopped || this.paused) return;
    const finalAt = timing.finalAt ?? Date.now();
    // Capture order is taken NOW, as the final arrives — before the echo
    // guard holds the candidate's turns — and persisted with the row.
    const captured = ++this.captureOrder;
    const own = speaker !== this.mode.remoteSpeaker;
    if (own) {
      // The user's own words: kept and remembered, never answered — and held
      // briefly so the microphone's echo of the call (speakers, no headphones)
      // is dropped instead of showing every remote turn twice. Its place in
      // the conversation's order is reserved NOW, when it was captured; it
      // only counts once the echo guard confirms it.
      const order = this.scheduler?.orderMark();
      this.echo.ownTurn(text, () => {
        if (this.stopped) return;
        this.commitTurn(text, speaker, finalAt, captured);
        // The candidate spoke: the interviewer's next words start a new
        // question rather than continue the last one. Only once the echo
        // guard has CONFIRMED the turn is theirs (on laptop speakers the
        // mic's copy of the interviewer would otherwise split a question),
        // ordered by when it was spoken. "Okay" / "mm-hmm" does not count.
        if (assessUtterance(text).verdict !== 'not') this.scheduler?.onCandidateTurn(order);
      });
      return;
    }
    this.echo.remoteTurn(text);
    const tcId = this.commitTurn(text, speaker, finalAt, captured);
    if (timing.speechEndAt) this.speechEnds.set(tcId, { at: timing.speechEndAt, source: timing.speechEndSource });
    if (this.speechEnds.size > 64) this.speechEnds.delete(this.speechEnds.keys().next().value!);
    this.remoteTurns.push({ text, tcId, at: finalAt });
    if (this.remoteTurns.length > 12) this.remoteTurns.shift();

    // Ambient modes (Meeting): the turn runs the ambient trigger and may
    // become a quiet card — never a streamed auto-answer. Direct asks still
    // reach the Q&A path below via handleEvent('direct_ask').
    if (this.mode.ambient && this.ambientPolicy) {
      await this.handleAmbient(text, tcId);
      return;
    }

    // Coding session with answering suppressed: keep transcribing (so the words
    // still show), but DON'T auto-answer — that would replace the coding answer.
    // Remember the utterance so toggling answering on can answer it.
    if (this.suppressAnswers) {
      this.pendingQuestionText = text;
      return;
    }

    // Interview: the scheduler owns what happens next — detection runs on
    // EVERY interviewer final, even while an answer streams (v1 returned
    // early here, so a question asked during an answer was never evaluated).
    // One stream at a time is still the rule; the scheduler queues behind it.
    // See interview/questionScheduler.ts for the policy.
    await this.scheduler?.onRemoteFinal(text, tcId, finalAt);
  }

  /** Run one scheduled question: register its row (or re-use it for a
   *  revision) and stream the answer. */
  private async answerScheduled(job: QuestionJob): Promise<void> {
    const q = { type: job.type, confidence: job.confidence, strategy: job.strategy };
    const tcId = job.transcriptChunkIds[job.transcriptChunkIds.length - 1] ?? null;
    // Speech end of the turn that completed the question.
    const speechEnd = tcId ? this.speechEnds.get(tcId) : undefined;
    if (job.questionId) {
      // A split/corrected question: same row, same card, new wording. Only
      // the scheduler's own stale stream is stopped — a manual Ask holding
      // the slot is never cancelled by an automatic revision.
      this.abortScheduled();
      persist.updateQuestionText(job.questionId, job.text, tcId);
      emitContributionReset(job.questionId);
      emitContributionTitle(job.questionId, job.text);
      if (this.lastQuestion?.questionId === job.questionId) this.lastQuestion.text = job.text;
    } else {
      job.questionId = this.registerQuestion(job.text, q, tcId);
    }
    const route = taskRoute('answer');
    const take = latency.begin({
      questionId: job.questionId,
      sessionId: this.sessionId,
      ...this.latencyClass(job.type),
      speechEndAt: speechEnd?.at,
      speechEndSource: speechEnd?.source,
      finalAt: job.finalAt,
      decidedAt: job.decidedAt,
      detection: `${job.detection.source}/${job.detection.reason}`,
      provider: route?.provider,
      model: route?.model,
    });
    // generateContribution claims the slot synchronously, before its first
    // await — remember which stream is the scheduler's.
    const stream = this.generateContribution(job.questionId, job.text, job.type, { take });
    this.scheduledAbort = this.answerAbort;
    await stream;
  }

  /** The stream the scheduler started, if it still holds the slot. */
  private scheduledAbort: AbortController | null = null;

  /** Abort the scheduler's own answer — never a manual Ask or regenerate that
   *  holds the slot instead (M3 review: a correction cancelled a manual Ask). */
  private abortScheduled(): void {
    if (this.answerAbort && this.answerAbort === this.scheduledAbort) this.answerAbort.abort();
  }

  /** A question that will not be answered automatically still gets a card —
   *  no answer, and one tap (↻) to answer it. Never silently dropped. */
  private surfaceMissed(job: QuestionJob, why: MissReason): void {
    if (this.stopped) return;
    // Never while an answer streams: opening a card collapses the streaming
    // one in the Cue Card. Shown as soon as the slot frees instead.
    if (this.answering) {
      this.pendingMissed.push({ job, why });
      return;
    }
    const riskWarning =
      why === 'paused'
        ? 'Asked while paused — not answered. Press ↻ to answer it.'
        : why === 'late'
          ? 'Recognised as a question only after the conversation moved on — not answered. Press ↻ to answer it.'
          : 'Asked while other answers were waiting — not answered. Press ↻ to answer it.';
    const tcId = job.transcriptChunkIds[job.transcriptChunkIds.length - 1] ?? null;
    let questionId: string;
    if (job.questionId) {
      // A revision of an existing card that never got re-answered (it waited
      // behind a manual Ask, then Pause): mark THAT card with the revised
      // wording, never open a second. Its old answer was to the old wording —
      // cleared, so the card and the saved session agree.
      questionId = job.questionId;
      persist.updateQuestionText(questionId, job.text, tcId);
      persist.replaceAnswer({ questionId, directAnswer: '', riskWarning, tokens: null });
      emitContributionReset(questionId);
      emitContributionTitle(questionId, job.text);
      if (this.lastQuestion?.questionId === questionId) this.lastQuestion.text = job.text;
    } else {
      questionId = this.registerQuestion(
        job.text,
        { type: job.type, confidence: job.confidence, strategy: job.strategy },
        tcId,
        { abortInFlight: false },
      );
      // On screen now: a later revision of it marks this card, not a new one.
      job.questionId = questionId;
    }
    // In the latency sample as an unanswered question — never left out.
    const speechEnd = tcId ? this.speechEnds.get(tcId) : undefined;
    latency.missed({
      questionId,
      sessionId: this.sessionId,
      ...this.latencyClass(job.type),
      speechEndAt: speechEnd?.at,
      speechEndSource: speechEnd?.source,
      finalAt: job.finalAt,
      decidedAt: job.decidedAt,
      detection: `${job.detection.source}/${job.detection.reason}`,
      reason: why,
    });
    // `missed` lets the Cue Card keep this card (and its retry) visible
    // as a missed question, apart from the answers.
    emitContributionMeta(questionId, { questionId, riskWarning, missed: why });
    emitContributionDone(questionId);
  }

  /** Manual escape hatch (Cue Card "Answer that"): answer the interviewer's
   *  latest words as a question, whatever detection decided. Joins the last
   *  two interviewer turns when they came close together (a split question). */
  async answerLastHeard(): Promise<{ ok: boolean }> {
    const turns = this.remoteTurns;
    const last = turns[turns.length - 1];
    if (!last || this.stopped) return { ok: false };
    const prev = turns[turns.length - 2];
    const joined = !!prev && last.at - prev.at < 6000 && assessUtterance(prev.text).verdict !== 'not';
    const text = joined ? `${prev.text} ${last.text}` : last.text;
    const a = assessUtterance(text);
    await this.answerQuestion(text, { type: a.type, confidence: 1, strategy: '' }, last.tcId);
    return { ok: true };
  }

  /** Start retrieval while the speaker is still finishing the question.
   *
   *  The answer path used to be: final transcript → embed the question →
   *  search → first token, with the embedding round trip (≈1–1.5 s) paid
   *  AFTER the endpoint had already waited for silence. The interim text
   *  reads as a question long before the final lands, so the embedding and
   *  search run then, and generateContribution finds the context ready. One
   *  prefetch per turn, refreshed when the turn has grown by half again, so a
   *  long question does not pay for every delta. Never throws; a failed
   *  prefetch simply falls back to grounding on the final. */
  prefetchGrounding(interim: string): void {
    if (this.stopped || this.paused) return;
    const words = turnWords(interim);
    if (words.length < 4) return;
    if (this.prefetch && words.length < this.prefetch.words.length * 1.5) return;
    if (evaluateTurnHeuristics(interim).type !== 'question') return;
    const session = persist.sessionRow(this.sessionId);
    if (!session) return;
    // Memory recall rides along (M7.2b): it used to start only after the
    // final's documents were ready — a second embedding round trip, in
    // series, on every answer with memory on.
    const promise = this.gather(session.profileId, interim, session.packId);
    promise.catch(() => {}); // a failed prefetch is gathered afresh on the final
    this.prefetch = { words, promise };
  }

  /** Documents and memory for a question, in PARALLEL — they used to run one
   *  after the other. Memories are not marked used here (a prefetch may be
   *  discarded); generateContribution marks the ones an answer uses. */
  private gather(profileId: string, questionText: string, packId: string | null): Promise<Gathered> {
    const lexical: Gathered['lexical'] = [];
    const timed = async <T>(work: () => Promise<T>) => {
      const start = Date.now();
      const value = await work();
      return { value, ms: Date.now() - start };
    };
    const docs = timed(() =>
      ground(profileId, this.retrievalQuery(questionText), packId, this.mode.id, { onLexical: () => lexical.push('documents') }),
    );
    const memory = timed(() =>
      recallMemories(profileId, questionText, packId, Date.now(), { markUsed: false, onLexical: () => lexical.push('memory') }),
    );
    return Promise.all([docs, memory]).then(([d, m]) => ({
      chunks: d.value,
      memories: m.value,
      retrievalMs: d.ms,
      recallMs: m.ms,
      lexical,
    }));
  }

  /** The latency bucket of a question (General / Technical / coding). */
  private latencyClass(questionType: string): Pick<QuestionTiming, 'category' | 'format' | 'questionType'> {
    return {
      category: latencyCategory(questionType, this.settings.answerFormat),
      format: this.settings.answerFormat,
      questionType,
    };
  }

  /** The prefetched context when it was for THIS question, else null. */
  private takePrefetch(questionText: string): Promise<Gathered> | null {
    const p = this.prefetch;
    this.prefetch = null;
    if (!p) return null;
    return sameWords(p.words, turnWords(questionText)) ? p.promise : null;
  }

  /** Persist a turn, broadcast it to the transcript and add it to the
   *  conversation context at the time it was spoken. The user's own turns
   *  are the candidate's ("You said:" in the prompt). */
  private commitTurn(text: string, speaker: Speaker, at = Date.now(), captured = ++this.captureOrder): string {
    const tcId = persist.finalTranscript(this.sessionId, speaker, text, at, captured);
    broadcast(EVENTS.transcriptDelta, { text, isFinal: true, speaker });
    this.context.addTurn(speaker === this.mode.remoteSpeaker ? 'interviewer' : 'candidate', text, at, captured);
    return tcId;
  }

  /** Ambient turn (Meeting): evaluate → maybe build a card → persist +
   *  broadcast (generic contribution events only). Failures are logged
   *  silence — a broken card must never interrupt a meeting. */
  private async handleAmbient(text: string, transcriptChunkId: string): Promise<void> {
    try {
      const decision = await this.ambientPolicy!.evaluate(text, Date.now());
      if (this.stopped || !decision.act || !decision.kind) return;
      // A question at balanced/active presence streams a grounded answer
      // through the same path a summon uses, instead of a card that only
      // quotes the question back. One answer at a time: while one is still
      // streaming, the new question falls through to the card below.
      if (decision.answer && !this.answering) {
        await this.answerQuestion(
          text,
          { type: 'meeting', confidence: decision.confidence, strategy: 'grounded' },
          transcriptChunkId,
        );
        return;
      }
      const card = await this.mode.ambient!.buildCard(decision, {
        turnText: text,
        transcriptChunkId,
        profileId: this.profileId,
        packId: this.packId,
      });
      if (!card || this.stopped) return;
      const contributionId = persist.insertContribution({
        sessionId: this.sessionId,
        kind: card.kind,
        title: card.title,
        body: card.body,
        meta: card.meta,
        sourceRefs: card.sourceRefs,
      });
      emitAmbientContribution({
        contributionId,
        kind: card.kind,
        title: card.title,
        body: card.body,
        contextChunks: card.contextChunks,
        meta: card.meta,
      });
    } catch (e) {
      log.error('ambient contribution failed', e);
    }
  }

  /** Manual ask (Cue Card Ask box): summoned trigger, no classification. */
  async directAsk(text: string): Promise<void> {
    const decision = await summonedPolicy.evaluate(text);
    await this.answerQuestion(text, decision.question!, null);
  }

  /** Register the question row + broadcast it, then stream the contribution. */
  async answerQuestion(
    questionText: string,
    q: { type: string; confidence: number; strategy: string },
    transcriptChunkId: string | null,
  ): Promise<{ questionId: string }> {
    const questionId = this.registerQuestion(questionText, q, transcriptChunkId);
    return this.generateContribution(questionId, questionText, q.type);
  }

  /** Insert the question row and open its card (synchronous). Aborts any
   *  in-flight answer FIRST — before the broadcast that clears the Cue Card —
   *  so a late token from the old stream can't land in the new card. */
  private registerQuestion(
    questionText: string,
    q: { type: string; confidence: number; strategy: string },
    transcriptChunkId: string | null,
    opts: { abortInFlight?: boolean } = {},
  ): string {
    const session = persist.sessionRow(this.sessionId);
    if (!session) throw new Error('Session not found');
    if (opts.abortInFlight !== false) this.answerAbort?.abort();

    const questionId = persist.insertQuestion({
      sessionId: this.sessionId,
      text: questionText,
      type: q.type,
      confidence: q.confidence,
      strategy: q.strategy,
      transcriptChunkId,
    });
    emitContributionOpen({
      contributionId: questionId,
      kind: q.type === 'coding' ? 'code' : 'answer',
      title: questionText,
      legacyExtra: {
        sessionId: this.sessionId,
        type: q.type,
        confidence: q.confidence,
        strategy: q.strategy,
        createdAt: Date.now(),
      },
    });
    // Remember this question so the Cue Card can re-generate it (length/format/
    // pronunciation toggles) by reusing THIS question row — no duplicate line.
    this.lastQuestion = { questionId, text: questionText, type: q.type };
    return questionId;
  }

  /** Stream (or re-stream) the grounded contribution for an already-registered
   *  question. Reused by regenerate so toggling length/format doesn't insert a
   *  new question row or push a duplicate transcript line. */
  async generateContribution(
    questionId: string,
    questionText: string,
    questionType?: string,
    /** The latency take of an automatically detected question (answerScheduled).
     *  Manual asks and regenerates are not timed. */
    timed?: { take: number },
  ): Promise<{ questionId: string }> {
    const session = persist.sessionRow(this.sessionId);
    if (!session) throw new Error('Session not found');
    const profile = profilesRepo.get(session.profileId);
    if (!profile) throw new Error('Profile not found');

    let answer = '';
    let tokens: { prompt: number; completion: number } | null = null;
    let meta: Record<string, unknown> = {};
    // Invalidate any in-flight follow-up prediction from a previous take of this
    // question — bumped at STREAM START so even an aborted regenerate supersedes.
    const followupGen = (this.followupGeneration.get(questionId) ?? 0) + 1;
    this.followupGeneration.set(questionId, followupGen);
    const abort = new AbortController();
    this.answering = true;
    this.answerAbort = abort;
    let context: RetrievedChunk[] = [];
    let memories: RetrievedMemory[] = [];
    const mark = (patch: Partial<QuestionTiming>) => timed && latency.mark(questionId, patch, timed.take);
    const finish = (outcome: Outcome, patch: Partial<QuestionTiming> = {}) =>
      timed && latency.finish(questionId, outcome, patch, timed.take);
    try {
      // Retrieval (an embeddings call) is INSIDE the try so a failure here is
      // surfaced + un-wedges the card too — not just generate failures.
      // Snapshot NOW, synchronously: turns that arrive while this answer
      // streams cannot change the context it is built on.
      const conversation = this.context.snapshot(questionText);
      const t0 = Date.now();
      mark({ dispatchAt: t0 });
      // Documents and approved memory (consent-gated; [] when off — recall
      // never throws; cited separately as [M1]…), gathered in parallel —
      // usually already on the interim. A failed prefetch gathers afresh.
      const pending = this.takePrefetch(questionText);
      const early = pending ? await pending.catch(() => null) : null;
      const gathered = early ?? (await this.gather(profile.id, questionText, session.packId));
      context = gathered.chunks;
      memories = gathered.memories;
      markRecalled(memories);
      const tReady = Date.now();
      if (gathered.lexical.length)
        log.warn(`answer grounding ranked lexically (${gathered.lexical.join(', ')}): the query embedding was late or failed`);
      mark({
        prefetched: !!early,
        retrievalMs: gathered.retrievalMs,
        recallMs: gathered.recallMs,
        chunks: context.length,
        memories: memories.length,
        ...(gathered.lexical.length ? { lexical: [...gathered.lexical] } : {}),
      });
      let firstToken = 0;
      // The route is captured HERE, before anything is sent, and travels with
      // the request; settings changed from now on apply to the NEXT question.
      let attemptRoute = taskRoute('answer');
      const failedAttempts: NonNullable<AnswerRoute['failed']> = [];
      const answeredBy = (): AnswerRoute | null =>
        attemptRoute
          ? { provider: attemptRoute.provider, model: attemptRoute.model, ...(failedAttempts.length ? { failed: [...failedAttempts] } : {}) }
          : null;
      // Transparency: tell the UI exactly what was sent to the provider —
      // memories included, so "data sent" always shows every memory used.
      emitContributionContext(questionId, {
        questionId,
        question: questionText,
        chunks: context,
        ...(memories.length ? { memories } : {}),
        ...(attemptRoute ? { sentTo: { provider: attemptRoute.provider, model: attemptRoute.model } } : {}),
      });
      // Bounded failover (docs/06 §Failover): at most ONE retry, and only
      // before any token was shown — a partly streamed answer is never
      // replayed as a duplicate. A model the account does not have is
      // skipped for the next candidate on the SAME provider (no interview
      // data goes to a provider the user did not choose); a transient
      // network/5xx error is retried once. Auth and quota errors surface.
      // Each attempt's route is captured BEFORE it is sent and travels with
      // it; a failure is attributed to that route (never to whatever the
      // task resolves to when the error arrives).
      for (let attempt = 0; ; attempt++) {
        // Diagnostics: provider/model per attempt — never a key or any text.
        log.info(`answer attempt ${attempt + 1} → ${attemptRoute ? `${attemptRoute.provider}/${attemptRoute.model}` : 'unrouted'}`);
        mark({ requestAt: Date.now() }); // the first attempt's (one-shot)
        try {
      for await (const ev of this.mode.generate({
        ...(attemptRoute ? { route: attemptRoute } : {}),
        question: questionText,
        contextChunks: context,
        memories,
        profile,
        settings: this.settings,
        conversation,
        questionType,
        signal: abort.signal,
      })) {
        if (ev.type === 'delta') {
          if (!firstToken) {
            firstToken = Date.now();
            // The answering attempt's route, not the one seeded at dispatch.
            mark({
              firstTokenAt: firstToken,
              ...(attemptRoute ? { provider: attemptRoute.provider, model: attemptRoute.model } : {}),
              ...(failedAttempts.length ? { failedAttempts: failedAttempts.length } : {}),
            });
            // Where the wait before the first token goes (no transcript text).
            log.info(
              `answer latency: context ${tReady - t0} ms (documents ${gathered.retrievalMs} ms, memory ${gathered.recallMs} ms${early ? ', started on the interim' : ''}), first token ${firstToken - tReady} ms`,
            );
          }
          answer += ev.token;
          emitContributionDelta(questionId, ev.token);
        } else if (ev.type === 'usage') {
          tokens = { prompt: ev.prompt, completion: ev.completion };
        } else if (ev.type === 'meta') {
          meta = ev;
          emitContributionMeta(questionId, { questionId, ...ev, answeredBy: answeredBy() });
        }
      }
          meta = { ...meta, answeredBy: answeredBy() };
          log.info(
            `answer served by ${attemptRoute ? `${attemptRoute.provider}/${attemptRoute.model}` : 'unrouted'}${failedAttempts.length ? ` after ${failedAttempts.length} failed attempt(s)` : ''}`,
          );
          break;
        } catch (e) {
          if (abort.signal.aborted || answer || attempt >= 1) throw e;
          const kind = providerErrorKind(e);
          if (kind === 'model') {
            const failed = attemptRoute;
            // Pinned to the provider this request went to: a retry may change
            // the MODEL, never the provider (an override's provider included).
            const next = failed ? retryRouteAfterModelError('answer', failed) : null;
            if (!next || !failed) throw e;
            failedAttempts.push({ provider: failed.provider, model: failed.model, reason: 'model' });
            attemptRoute = next;
            log.warn(`answer model unavailable (${failed?.provider}/${failed?.model}) — retrying on ${next.provider}/${next.model}`);
            broadcast(EVENTS.sessionError, {
              message: `${failed?.model ?? 'The answer model'} isn't available to your account — answering with ${next.model} instead. Pick another in Settings → Language Models to change it.`,
            });
            continue;
          }
          if (kind === 'network') {
            log.warn('answer stream failed before its first token (network) — retrying once');
            if (attemptRoute) failedAttempts.push({ provider: attemptRoute.provider, model: attemptRoute.model, reason: 'network' });
            await new Promise((r) => setTimeout(r, 400));
            if (abort.signal.aborted) throw e;
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      // Aborted by clear/regenerate — drop this partial answer, but still tell the
      // Cue Card this question is done so its card stops showing the streaming
      // cursor. (With per-card regenerate + history, the aborted card may be a
      // DIFFERENT, still-visible one than the card being regenerated.)
      if (abort.signal.aborted) {
        finish('aborted');
        emitContributionDone(questionId);
        return { questionId };
      }
      finish('failed', { reason: providerErrorKind(e) });
      // A real failure (auth, quota, network drop, model-not-found): surface it and
      // clear the Cue Card's streaming state, instead of leaving the card spinning
      // forever with no error (the most common live failure — e.g. an expired key).
      broadcast(EVENTS.sessionError, { message: normalizeProviderError(e) });
      emitContributionDone(questionId);
      throw e;
    } finally {
      // Only the stream that still OWNS the slot may release it. An aborted stream
      // that was already replaced (regenerate / format toggle / manual Ask) must not
      // clear the replacement's `answering` claim — that would reopen the no-overlap
      // gate while the new answer is still streaming.
      if (this.answerAbort === abort) {
        this.answering = false;
        this.answerAbort = null;
        // A detected question may be waiting behind this stream (a manual
        // Ask or regenerate held the slot) — let the scheduler start it.
        if (this.scheduler)
          queueMicrotask(() => {
            for (const m of this.pendingMissed.splice(0)) this.surfaceMissed(m.job, m.why);
            this.scheduler?.slotFreed();
          });
      }
    }

    finish(answer.trim() ? 'answered' : 'empty', {
      completedAt: Date.now(),
      ...(tokens ? { promptTokens: tokens.prompt, completionTokens: tokens.completion } : {}),
    });
    if (answer.trim()) this.context.addSuggestion(questionId, questionText, answer);
    persist.replaceAnswer({
      questionId,
      directAnswer: answer,
      riskWarning: (meta.riskWarning as string) ?? null,
      tokens,
    });
    // Dual-write the generic contribution (same only-on-completion semantics as
    // ai_answers — see enginePersistence).
    persist.insertContribution({
      sessionId: this.sessionId,
      kind: 'answer',
      title: questionText,
      body: answer,
      meta: {
        questionId,
        riskWarning: (meta.riskWarning as string) ?? null,
        tokens,
        // Which provider/model produced this saved answer (no keys, no text).
        ...(meta.answeredBy ? { answeredBy: meta.answeredBy } : {}),
      },
      sourceRefs: [
        { type: 'question', id: questionId },
        ...context.map((c) => ({ type: 'chunk', id: c.id })),
        // Provenance: every memory that grounded this answer stays traceable.
        ...memories.map((m) => ({ type: 'memory', id: m.id })),
      ],
    });

    emitContributionDone(questionId);

    // Predict the likely follow-up AFTER the answer is done — a cheap
    // classify-tier call that can never touch first-token latency.
    // Fire-and-forget: a failed prediction is silent. Skipped for mock
    // rehearsals (the AI interviewer generates its own next question anyway).
    if (answer && !this.ephemeral && !this.stopped && this.mode.predictFollowup) {
      const settings = { ...this.settings };
      void this.mode
        .predictFollowup({ question: questionText, answer, settings })
        .then((followup) => {
          if (!followup) return;
          // Stale guards: a regenerate superseded this prediction, or the
          // session changed while it was in flight — drop it silently.
          if (this.followupGeneration.get(questionId) !== followupGen) return;
          if (this.stopped) return;
          persist.setFollowup(questionId, followup);
          emitContributionFollowup(questionId, followup, ['overlay']);
        })
        .catch((e) => log.warn('followup prediction failed', e));
    }

    return { questionId };
  }

  /** Re-answer a question — a SPECIFIC one by id (per-card "Regenerate") or,
   *  with no id, the last question (after toggling format/pronunciation).
   *  Reuses the SAME question row — no new transcript line or DB question. */
  async regenerate(questionId?: string): Promise<{ regenerated: boolean }> {
    let qid: string;
    let text: string;
    let type: string | undefined;
    if (questionId) {
      // A specific card: pull its text (+ classified type) from its question
      // row (any question in this session).
      const row = persist.question(questionId);
      if (row === null) return { regenerated: false }; // e.g. an ad-hoc coding-solve card (not persisted)
      qid = questionId;
      text = row.text;
      type = row.type;
    } else if (this.lastQuestion) {
      qid = this.lastQuestion.questionId;
      text = this.lastQuestion.text;
      type = this.lastQuestion.type;
    } else {
      return { regenerated: false };
    }
    // Abort the current answer BEFORE clearing the Cue Card, so a late token from
    // the aborted stream can't land in the cleared answer.
    this.answerAbort?.abort();
    // Clear that question's answer in the Cue Card (without touching the transcript).
    emitContributionReset(qid);
    await this.generateContribution(qid, text, type);
    return { regenerated: true };
  }

  /** The text retrieval embeds — a referential follow-up carries its
   *  subject from what the candidate actually said (conversationContext.ts). */
  private retrievalQuery(questionText: string): string {
    return this.context.retrievalQuery(questionText);
  }
}
