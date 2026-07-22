import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import { normalizeOpenAIError } from '../openai/client';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { log } from '../security/logger';
import { ground } from './grounding';
import { enginePersistence as persist } from './persistence/enginePersistence';
import { summonedPolicy } from './trigger/summonedPolicy';
import type { RealtimeSttSession } from '../../providers/types';
import type { ContextEvent } from './contextEvent';
import type { ModeDefinition, RuntimeSettings } from './modeDefinition';

/** A question we answered, kept so the Cue Card can re-generate it (e.g. after
 *  toggling length/format/pronunciation) by reusing the SAME question row — no
 *  duplicate question/transcript line. */
interface LastQuestion {
  questionId: string;
  text: string;
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
  // Coding sessions default to "listen but don't auto-answer" so a generated coding
  // answer isn't replaced when the remote speaker talks. We keep transcribing and
  // remember the last utterance so toggling answering on can answer it.
  suppressAnswers = false;
  pendingQuestionText: string | null = null;
  transcriber: RealtimeSttSession | null = null;

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
  }) {
    this.sessionId = opts.sessionId;
    this.profileId = opts.profileId;
    this.packId = opts.packId;
    this.mode = opts.mode;
    this.settings = opts.settings;
    this.ephemeral = opts.ephemeral;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Abort in-flight work and release the transcriber. Idempotent. */
  teardown(): void {
    this.answerAbort?.abort();
    this.transcriber?.stop();
    this.transcriber = null;
    this.stopped = true;
  }

  /** Normalized entry point for sources. Control events are handled by the
   *  engine (they affect which session is live); everything else lands here. */
  async handleEvent(ev: ContextEvent): Promise<void> {
    switch (ev.kind) {
      case 'transcript_final':
        return this.onTranscriptFinal(ev.text);
      case 'direct_ask':
        return this.directAsk(ev.text);
      default:
        // transcript_delta streams straight to the overlay; screen/clipboard
        // still enter via services/capture (see contextEvent.ts).
        return;
    }
  }

  /** Persist a finalized transcript turn, run the trigger policy, and (when it
   *  says act) generate the contribution. */
  async onTranscriptFinal(text: string): Promise<void> {
    if (!text || this.stopped || this.paused) return;
    const tcId = persist.finalTranscript(this.sessionId, this.mode.remoteSpeaker, text);
    broadcast(EVENTS.transcriptDelta, { text, isFinal: true, speaker: this.mode.remoteSpeaker });

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
    broadcast(EVENTS.questionDetected, {
      id: questionId,
      sessionId: this.sessionId,
      text: questionText,
      type: q.type,
      confidence: q.confidence,
      strategy: q.strategy,
      createdAt: Date.now(),
    });
    // Remember this question so the Cue Card can re-generate it (length/format/
    // pronunciation toggles) by reusing THIS question row — no duplicate line.
    this.lastQuestion = { questionId, text: questionText };

    return this.generateContribution(questionId, questionText);
  }

  /** Stream (or re-stream) the grounded contribution for an already-registered
   *  question. Reused by regenerate so toggling length/format doesn't insert a
   *  new question row or push a duplicate transcript line. */
  async generateContribution(
    questionId: string,
    questionText: string,
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
    try {
      // Retrieval (an embeddings call) is INSIDE the try so a failure here is
      // surfaced + un-wedges the card too — not just generate failures.
      context = await ground(profile.id, questionText, session.packId);
      // Transparency: tell the UI exactly what was sent to the provider.
      broadcast(EVENTS.contextSent, { questionId, question: questionText, chunks: context });
      for await (const ev of this.mode.generate({
        question: questionText,
        contextChunks: context,
        profile,
        settings: this.settings,
        signal: abort.signal,
      })) {
        if (ev.type === 'delta') {
          answer += ev.token;
          broadcast(EVENTS.answerDelta, { questionId, token: ev.token });
        } else if (ev.type === 'usage') {
          tokens = { prompt: ev.prompt, completion: ev.completion };
        } else if (ev.type === 'meta') {
          meta = ev;
          broadcast(EVENTS.answerMeta, { questionId, ...ev });
        }
      }
    } catch (e) {
      // Aborted by clear/regenerate — drop this partial answer, but still tell the
      // Cue Card this question is done so its card stops showing the streaming
      // cursor. (With per-card regenerate + history, the aborted card may be a
      // DIFFERENT, still-visible one than the card being regenerated.)
      if (abort.signal.aborted) {
        broadcast(EVENTS.answerDone, { questionId });
        return { questionId };
      }
      // A real failure (auth, quota, network drop, model-not-found): surface it and
      // clear the Cue Card's streaming state, instead of leaving the card spinning
      // forever with no error (the most common live failure — e.g. an expired key).
      broadcast(EVENTS.sessionError, { message: normalizeOpenAIError(e) });
      broadcast(EVENTS.answerDone, { questionId });
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
      ],
    });

    broadcast(EVENTS.answerDone, { questionId });

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
          broadcast(EVENTS.answerFollowup, { questionId, followup }, ['overlay']);
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
    if (questionId) {
      // A specific card: pull its text from its question row (any question in
      // this session).
      const rowText = persist.questionText(questionId);
      if (rowText === null) return { regenerated: false }; // e.g. an ad-hoc coding-solve card (not persisted)
      qid = questionId;
      text = rowText;
    } else if (this.lastQuestion) {
      qid = this.lastQuestion.questionId;
      text = this.lastQuestion.text;
    } else {
      return { regenerated: false };
    }
    // Abort the current answer BEFORE clearing the Cue Card, so a late token from
    // the aborted stream can't land in the cleared answer.
    this.answerAbort?.abort();
    // Clear that question's answer in the Cue Card (without touching the transcript).
    broadcast(EVENTS.answerReset, { questionId: qid });
    await this.generateContribution(qid, text);
    return { regenerated: true };
  }
}
