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
} from '../../ipc/contributionBridge';
import { normalizeProviderError } from '../../providers/normalizeError';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { log } from '../security/logger';
import { recallMemories } from '../memory/recall';
import { ground } from './grounding';
import { enginePersistence as persist } from './persistence/enginePersistence';
import { EchoGuard, sameWords, turnWords } from './echoGuard';
import { evaluateTurnHeuristics } from './trigger/meetingHeuristics';
import type { RetrievedChunk } from '@shared/types';
import { summonedPolicy } from './trigger/summonedPolicy';
import type { AudioSource, Speaker } from '@shared/types';
import type { RealtimeSttSession } from '../../providers/types';
import type { SessionHistory, SessionHistoryItem } from '../openai/answer';
import type { ContextEvent } from './contextEvent';
import type { AmbientPolicy, ModeDefinition, RuntimeSettings } from './modeDefinition';

/** A question we answered, kept so the Cue Card can re-generate it (e.g. after
 *  toggling length/format/pronunciation) by reusing the SAME question row — no
 *  duplicate question/transcript line. */
interface LastQuestion {
  questionId: string;
  text: string;
  /** Classifier type ('behavioral', 'technical', …) — regenerate re-sends it. */
  type: string;
}

/** In-session history budget. Sized for the prompt, not the archive: enough
 *  to resolve a follow-up against the last few exchanges, small enough that
 *  the CONTEXT/MEMORY blocks stay the dominant grounding. */
const HISTORY_MAX_ITEMS = 10;
const HISTORY_TURN_CHARS = 300;
const HISTORY_ANSWER_CHARS = 700;
/** A question this short is almost always referential ("and the timeline?"),
 *  so retrieval embeds it together with the previous question. */
const REFERENTIAL_MAX_WORDS = 8;
/** How much of the previous answer joins a referential follow-up's retrieval
 *  query — its lead names the subject; the rest would drown the question. */
const REFERENTIAL_ANSWER_CHARS = 240;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

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
  /** What this session has heard and answered so far, oldest first. Handed to
   *  the generator so question N knows about question N-1 — without it every
   *  cue was a cold start and "what about the second option?" was unanswerable.
   *  Prompt-only: the DB rows remain the record. */
  private readonly history: SessionHistoryItem[] = [];
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
  /** Grounding started on the INTERIM transcript, before the turn's final
   *  (see prefetchGrounding). Consumed by the next generateContribution whose
   *  question says the same words; otherwise discarded. */
  private prefetch: { words: string[]; promise: Promise<RetrievedChunk[]> } | null = null;
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
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Abort in-flight work and release every transcriber. Idempotent. */
  teardown(): void {
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
        return this.onTranscriptFinal(ev.text, ev.speaker);
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
  async onTranscriptFinal(text: string, speaker: Speaker = this.mode.remoteSpeaker): Promise<void> {
    if (!text || this.stopped || this.paused) return;
    const own = speaker !== this.mode.remoteSpeaker;
    if (own) {
      // The user's own words: kept and remembered, never answered — and held
      // briefly so the microphone's echo of the call (speakers, no headphones)
      // is dropped instead of showing every remote turn twice.
      this.echo.ownTurn(text, () => {
        if (!this.stopped) this.commitTurn(text, speaker);
      });
      return;
    }
    this.echo.remoteTurn(text);
    const tcId = this.commitTurn(text, speaker);

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

    // Don't pile up overlapping answers — if one is already streaming, just keep
    // transcribing. (The user can still ask manually.) Claim the slot
    // SYNCHRONOUSLY here, before the trigger's classify round-trip: two finals
    // arriving back-to-back would otherwise both pass this gate (the flag is only
    // set deep inside generateContribution, after two awaits) and double-answer
    // one utterance.
    if (this.answering) return;
    this.answering = true;

    try {
      const decision = await this.mode.trigger.evaluate(text);
      // Re-check: the session can be stopped/replaced during classify.
      if (this.stopped) return;
      if (decision.act && decision.question) {
        // answerQuestion → generateContribution re-sets `answering` and clears it
        // in its own finally, so the slot is released when the answer
        // completes/aborts.
        await this.answerQuestion(text, decision.question, tcId);
      } else {
        // Not a question — release the slot we claimed above, unless an answer
        // stream (manual Ask / regenerate during the classify await) has since
        // taken ownership: answerAbort is set exclusively by generateContribution,
        // and that stream's own finally releases the slot.
        if (!this.answerAbort) this.answering = false;
      }
    } catch (e) {
      if (!this.stopped && !this.answerAbort) this.answering = false;
      log.error('onTranscriptFinal failed', e);
    }
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
    this.prefetch = {
      words,
      promise: ground(session.profileId, this.retrievalQuery(interim), session.packId, this.mode.id).catch(() => []),
    };
  }

  /** The prefetched context when it was for THIS question, else null. */
  private takePrefetch(questionText: string): Promise<RetrievedChunk[]> | null {
    const p = this.prefetch;
    this.prefetch = null;
    if (!p) return null;
    return sameWords(p.words, turnWords(questionText)) ? p.promise : null;
  }

  /** Persist a turn, broadcast it to the transcript and remember it in the
   *  in-session history. The user's own turns carry their speaker so the
   *  prompt can label them "You said:"; remote turns keep the v1 item shape
   *  (pinned by parity). */
  private commitTurn(text: string, speaker: Speaker): string {
    const tcId = persist.finalTranscript(this.sessionId, speaker, text);
    broadcast(EVENTS.transcriptDelta, { text, isFinal: true, speaker });
    const clipped = clip(text, HISTORY_TURN_CHARS);
    this.remember(
      speaker !== this.mode.remoteSpeaker ? { role: 'heard', text: clipped, speaker } : { role: 'heard', text: clipped },
    );
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
    const session = persist.sessionRow(this.sessionId);
    if (!session) throw new Error('Session not found');

    // Cancel any in-flight answer BEFORE we broadcast the new question (which
    // clears the Cue Card answer), so a late token from the old stream can't
    // land in the freshly-cleared answer.
    this.answerAbort?.abort();

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

    return this.generateContribution(questionId, questionText, q.type);
  }

  /** Stream (or re-stream) the grounded contribution for an already-registered
   *  question. Reused by regenerate so toggling length/format doesn't insert a
   *  new question row or push a duplicate transcript line. */
  async generateContribution(
    questionId: string,
    questionText: string,
    questionType?: string,
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
    let context: Awaited<ReturnType<typeof ground>> = [];
    let memories: Awaited<ReturnType<typeof recallMemories>> = [];
    try {
      // Retrieval (an embeddings call) is INSIDE the try so a failure here is
      // surfaced + un-wedges the card too — not just generate failures.
      const history = this.historyBefore(questionText);
      const t0 = Date.now();
      const prefetched = this.takePrefetch(questionText);
      context = prefetched
        ? await prefetched
        : await ground(profile.id, this.retrievalQuery(questionText), session.packId, this.mode.id);
      const tGround = Date.now();
      // Approved memory joins the grounding (consent-gated; [] when off —
      // recall never throws). Cited separately from documents as [M1]….
      memories = await recallMemories(profile.id, questionText, session.packId);
      const tRecall = Date.now();
      let firstToken = 0;
      // Transparency: tell the UI exactly what was sent to the provider —
      // memories included, so "data sent" always shows every memory used.
      emitContributionContext(questionId, {
        questionId,
        question: questionText,
        chunks: context,
        ...(memories.length ? { memories } : {}),
      });
      for await (const ev of this.mode.generate({
        question: questionText,
        contextChunks: context,
        memories,
        profile,
        settings: this.settings,
        history,
        questionType,
        signal: abort.signal,
      })) {
        if (ev.type === 'delta') {
          if (!firstToken) {
            firstToken = Date.now();
            // Where the wait before the first token goes (no transcript text).
            log.info(
              `answer latency: ground ${tGround - t0} ms${prefetched ? ' (prefetched on interim)' : ''}, recall ${tRecall - tGround} ms, first token ${firstToken - tRecall} ms`,
            );
          }
          answer += ev.token;
          emitContributionDelta(questionId, ev.token);
        } else if (ev.type === 'usage') {
          tokens = { prompt: ev.prompt, completion: ev.completion };
        } else if (ev.type === 'meta') {
          meta = ev;
          emitContributionMeta(questionId, { questionId, ...ev });
        }
      }
    } catch (e) {
      // Aborted by clear/regenerate — drop this partial answer, but still tell the
      // Cue Card this question is done so its card stops showing the streaming
      // cursor. (With per-card regenerate + history, the aborted card may be a
      // DIFFERENT, still-visible one than the card being regenerated.)
      if (abort.signal.aborted) {
        emitContributionDone(questionId);
        return { questionId };
      }
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
      }
    }

    this.rememberAnswer(questionText, answer);
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
      meta: { questionId, riskWarning: (meta.riskWarning as string) ?? null, tokens },
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

  /** The history the model should see for THIS question: everything except
   *  the question itself — its own `heard` turn (pushed by onTranscriptFinal
   *  before the trigger ran) and, on a regenerate, its own previous take. */
  private historyBefore(questionText: string): SessionHistory | undefined {
    const self = clip(questionText, HISTORY_TURN_CHARS);
    const items = this.history.filter((h) =>
      h.role === 'heard' ? h.text !== self : h.question !== self,
    );
    return items.length ? items : undefined;
  }

  /** Append to the in-session history, dropping the oldest past the budget. */
  private remember(item: SessionHistoryItem): void {
    this.history.push(item);
    if (this.history.length > HISTORY_MAX_ITEMS) this.history.splice(0, this.history.length - HISTORY_MAX_ITEMS);
  }

  /** Record a completed answer. A regenerate of the same question updates its
   *  entry instead of adding a second; a detected question replaces the
   *  `heard` turn it came from so the exchange appears once. */
  private rememberAnswer(question: string, answer: string): void {
    const text = answer.trim();
    if (!text) return;
    const clipped = clip(text, HISTORY_ANSWER_CHARS);
    const existing = this.history.find((h) => h.role === 'asked' && h.question === question);
    if (existing && existing.role === 'asked') {
      existing.answer = clipped;
      return;
    }
    const last = this.history[this.history.length - 1];
    if (last?.role === 'heard' && last.text === clip(question, HISTORY_TURN_CHARS)) this.history.pop();
    this.remember({ role: 'asked', question: clip(question, HISTORY_TURN_CHARS), answer: clipped });
  }

  /** The text retrieval embeds. A short follow-up carries the previous
   *  question AND the opening of its answer with it, so "what was your role
   *  there?" retrieves chunks about the project the answer just named instead
   *  of about roles in general (the question alone rarely names the subject;
   *  the answer did). */
  private retrievalQuery(questionText: string): string {
    if (questionText.trim().split(/\s+/).length > REFERENTIAL_MAX_WORDS) return questionText;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.role === 'asked') {
        return `${h.question} ${clip(h.answer, REFERENTIAL_ANSWER_CHARS)} ${questionText}`;
      }
    }
    return questionText;
  }
}
