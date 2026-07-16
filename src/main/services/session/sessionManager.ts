import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { transcribeChunk } from '../openai/transcription';
import { classifyQuestion } from '../openai/questions';
import { streamAnswer } from '../openai/answer';
import { predictFollowup } from '../openai/followup';
import { normalizeOpenAIError } from '../openai/client';
import { retrieve } from '../rag/retriever';
import { RealtimeTranscriber } from '../openai/realtime';
import { getOverlayWindow, showOverlay } from '../../windows/overlayWindow';
import { getMainWindow } from '../../windows/mainWindow';
import { startCaptureShield, stopCaptureShield } from './privacy';
import { log } from '../security/logger';
import type { AnswerFormat, InterviewType, Session } from '@shared/types';

/** A question we answered, kept so the Cue Card can re-generate it (e.g. after
 *  toggling length/format/pronunciation) by reusing the SAME question row — no
 *  duplicate question/transcript line. */
interface LastQuestion {
  questionId: string;
  text: string;
}

interface LiveState {
  sessionId: string;
  profileId: string;
  jobId: string | null;
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
  isMock: boolean; // mock rehearsal — no mic capture; never persisted
  paused: boolean;
  busy: boolean; // a chunk is currently being processed (chunked fallback path)
  answering: boolean; // an answer is currently being generated (avoid overlap)
  answerAbort: AbortController | null; // cancels the in-flight answer (clear/regen)
  lastQuestion: LastQuestion | null;
  // Coding sessions default to "listen but don't auto-answer" so a generated coding
  // answer isn't replaced when the interviewer speaks. We keep transcribing and
  // remember the last utterance so toggling answering on can answer it.
  suppressAnswers: boolean;
  pendingQuestionText: string | null;
  transcriber: RealtimeTranscriber | null;
}

let live: LiveState | null = null;
let lastLevelAt = 0; // throttle the Cue Card audio-level meter broadcasts
// Follow-up predictions are fire-and-forget; a regenerate can leave an OLD
// answer's prediction in flight. Each generateAnswer bumps its question's
// generation, and a prediction only lands if its generation is still current —
// a stale follow-up must never annotate (or persist onto) a newer answer.
const followupGeneration = new Map<string, number>();

function toSession(r: typeof schema.sessions.$inferSelect): Session {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.jobId,
    kind: r.kind as Session['kind'],
    interviewType: r.interviewType as InterviewType,
    status: r.status as Session['status'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
  };
}

export const sessionManager = {
  /** Set up the live state + Realtime transcriber for a session row (shared by
   *  start and resume). Tears down any previous live session first. */
  goLive(opts: {
    sessionId: string;
    profileId: string;
    jobId: string | null;
    interviewType: InterviewType;
    answerFormat: AnswerFormat;
    language: string;
    isMock?: boolean;
  }): void {
    if (live?.answerAbort) live.answerAbort.abort(); // cancel any prior in-flight answer
    if (live?.transcriber) live.transcriber.stop(); // never leak a prior socket
    followupGeneration.clear(); // a fresh session invalidates all pending predictions
    live = {
      sessionId: opts.sessionId,
      profileId: opts.profileId,
      jobId: opts.jobId,
      interviewType: opts.interviewType,
      answerFormat: opts.answerFormat,
      pronunciation: true, // ON by default (v1.2); toggled live from the Cue Card
      isMock: !!opts.isMock,
      paused: false,
      busy: false,
      answering: false,
      answerAbort: null,
      lastQuestion: null,
      suppressAnswers: false,
      pendingQuestionText: null,
      transcriber: null,
    };
    showOverlay();
    // The live session captures loopback audio, which periodically clears our
    // windows' capture-exclusion; keep re-asserting it for the life of the
    // session (stopped in stop()/shutdown()). See startCaptureShield.
    startCaptureShield();

    // Real interviews stream STT via the Realtime API. A mock rehearsal has no
    // mic — its questions come from the AI interviewer — so skip the transcriber.
    if (!opts.isMock) {
      const transcriber = new RealtimeTranscriber(
        {
          onDelta: (text) =>
            broadcast(EVENTS.transcriptDelta, { text, isFinal: false, speaker: 'interviewer' }),
          onFinal: (text) => void this.processFinalTranscript(opts.sessionId, text),
          onError: (message) => broadcast(EVENTS.sessionError, { message }),
          // Socket lifecycle → a subtle "reconnecting audio…" pill in the Cue Card
          // (an unexpected drop mid-interview now recovers itself; see realtime.ts).
          onStatus: (status) => broadcast(EVENTS.transcriberStatus, { status }, ['overlay']),
        },
        opts.language || 'en',
      );
      transcriber.start();
      live.transcriber = transcriber;
    }

    broadcast(EVENTS.sessionState, { status: 'live', paused: false });
    // Seed the Cue Card's answer-control toggles with this round's prefs.
    broadcast(
      EVENTS.answerPrefs,
      {
        interviewType: opts.interviewType,
        format: opts.answerFormat,
        pronunciation: true,
      },
      ['overlay'],
    );
    // Push the client (job) + profile context to the Cue Card: it shows which
    // interview is running and lets the user pull up their notes mid-interview.
    const job = opts.jobId ? jobsRepo.get(opts.jobId) : null;
    const profile = profilesRepo.get(opts.profileId);
    broadcast(
      EVENTS.clientInfo,
      {
        company: job?.company ?? null,
        title: job?.title ?? 'Interview',
        notes: job?.notes ?? null,
        profileName: profile?.name ?? null,
        hasResume: !!profile?.parsedResume,
        hasJd: !!job?.parsedJd,
        hasCompany: !!job?.parsedCompany,
      },
      ['overlay'],
    );
  },

  start(
    profileId: string,
    interviewType: InterviewType,
    jobId: string | null = null,
    answerFormat: AnswerFormat = 'key_points',
  ): Session {
    const profile = profilesRepo.get(profileId);
    if (!profile) throw new Error('Profile not found');
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({ id, profileId, jobId, kind: 'live', interviewType, status: 'live', startedAt: Date.now() })
      .run();
    this.goLive({
      sessionId: id,
      profileId,
      jobId,
      interviewType,
      answerFormat,
      language: profile.language,
    });
    return toSession(db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()!);
  },

  /** Re-activate an existing (stopped) session and continue it, so one interview
   *  reuses a single session row instead of piling up new ones. The interview
   *  TYPE is restored from the session (it's switched live in the Cue Card, not
   *  chosen on resume); the answer format defaults and is adjusted live too. */
  resume(sessionId: string, answerFormat: AnswerFormat = 'key_points'): Session {
    const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!row) throw new Error('Session not found');
    const profile = profilesRepo.get(row.profileId);
    if (!profile) throw new Error('Profile not found');
    db()
      .update(schema.sessions)
      .set({ status: 'live', endedAt: null })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    this.goLive({
      sessionId,
      profileId: row.profileId,
      jobId: row.jobId,
      interviewType: row.interviewType as InterviewType,
      answerFormat,
      language: profile.language,
    });
    return toSession(
      db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!,
    );
  },

  /** Feed streaming PCM16 (24kHz mono) audio from the renderer to the transcriber. */
  feedRealtimeAudio(sessionId: string, pcm: ArrayBuffer): void {
    if (!live || live.sessionId !== sessionId || live.paused) return;
    live.transcriber?.appendAudio(Buffer.from(pcm).toString('base64'));
    // Drive the Cue Card audio meter — the mic stream lives in the dashboard
    // renderer, so we compute the level here (from the PCM we already receive)
    // and broadcast it, throttled to ~12/sec.
    const now = Date.now();
    if (now - lastLevelAt >= 80) {
      lastLevelAt = now;
      // This handler is on a raw ipcMain.on (no Result envelope), so a malformed
      // (odd-length) PCM frame must not throw — Int16Array requires an even byte
      // length, so floor to whole samples.
      const sampleCount = Math.floor(pcm.byteLength / 2);
      const samples = new Int16Array(pcm, 0, sampleCount);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i] / 32768;
        sum += v * v;
      }
      const level = samples.length ? Math.sqrt(sum / samples.length) : 0;
      broadcast(EVENTS.audioLevel, { level }, ['overlay']);
    }
  },

  /** Persist a finalized transcript turn, detect a question, and answer it. */
  async processFinalTranscript(sessionId: string, text: string): Promise<void> {
    if (!text || !live || live.sessionId !== sessionId || live.paused) return;
    const tcId = crypto.randomUUID();
    db()
      .insert(schema.transcriptChunks)
      .values({ id: tcId, sessionId, speaker: 'interviewer', text, isFinal: 1 })
      .run();
    broadcast(EVENTS.transcriptDelta, { text, isFinal: true, speaker: 'interviewer' });

    // Coding session with answering suppressed: keep transcribing (so the interviewer's
    // words still show), but DON'T auto-answer — that would replace the coding answer.
    // Remember the utterance so toggling answering on can answer it.
    if (live.suppressAnswers) {
      live.pendingQuestionText = text;
      return;
    }

    // Don't pile up overlapping answers — if one is already streaming, just keep
    // transcribing. (The user can still ask manually.) Claim the slot
    // SYNCHRONOUSLY here, before the classify round-trip: two finals arriving
    // back-to-back would otherwise both pass this gate (the flag is only set deep
    // inside generateAnswer, after two awaits) and double-answer one utterance.
    if (live.answering) return;
    live.answering = true;

    try {
      const classified = await classifyQuestion(text);
      // Re-check live: the session can be stopped/replaced during classify.
      if (live?.sessionId !== sessionId) return;
      if (classified.isQuestion && classified.confidence >= 0.4) {
        // answerQuestion → generateAnswer re-sets `answering` and clears it in its
        // own finally, so the slot is released when the answer completes/aborts.
        await this.answerQuestion(
          sessionId,
          text,
          classified.type,
          classified.confidence,
          classified.strategy,
          tcId,
        );
      } else {
        // Not a question — release the slot we claimed above, unless an answer
        // stream (manual Ask / regenerate during the classify await) has since
        // taken ownership: answerAbort is set exclusively by generateAnswer, and
        // that stream's own finally releases the slot.
        if (!live.answerAbort) live.answering = false;
      }
    } catch (e) {
      if (live?.sessionId === sessionId && !live.answerAbort) live.answering = false;
      log.error('processFinalTranscript failed', e);
    }
  },

  stop(sessionId: string): Session {
    db()
      .update(schema.sessions)
      .set({ status: 'stopped', endedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    // Snapshot the row now so we can still return it even if a mock session is
    // deleted below. The row can already be gone (e.g. the user pressed Stop on a
    // mock while its first question was in flight) — fail cleanly, not TypeError.
    const row = db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!row) throw new Error('Session not found');
    const result = toSession(row);
    // Only tear down the live UI when we actually stopped the LIVE session —
    // stopping some other (already-stopped) session row must not kill a running
    // one or hide the overlay out from under it.
    const wasLive = live?.sessionId === sessionId;
    if (wasLive) {
      stopCaptureShield(); // the loopback capture ends with the session
      const interviewType = live!.interviewType;
      const wasMock = live!.isMock;
      const jobTitle = live!.jobId ? (jobsRepo.get(live!.jobId)?.title ?? null) : null;
      live!.answerAbort?.abort(); // stop any in-flight answer stream
      live!.transcriber?.stop();
      live = null;
      broadcast(EVENTS.sessionState, { status: 'stopped', paused: false });
      broadcast(EVENTS.clientInfo, null, ['overlay']); // clear the Cue Card's client notes
      getOverlayWindow()?.hide(); // close the floating overlay when the session ends
      if (wasMock) {
        // Mock rehearsals are never persisted — drop the session + its Q/A.
        sessionsRepo.delete(sessionId);
      } else {
        // Ask the dashboard to save (pick the type) or discard the just-ended session.
        broadcast(
          EVENTS.savePrompt,
          {
            sessionId,
            interviewType,
            jobTitle,
            questionCount: sessionsRepo.questionCount(sessionId),
          },
          ['main'],
        );
        const mainWin = getMainWindow();
        if (mainWin) {
          mainWin.show();
          mainWin.focus();
        }
      }
    }
    return result;
  },

  /** Release the live transcription websocket on app exit so its socket/helper
   *  process doesn't linger. Does not touch the DB (the session row keeps its
   *  last status). Safe to call when nothing is live. */
  shutdown(): void {
    stopCaptureShield();
    if (live) {
      live.transcriber?.stop();
      live = null;
    }
  },

  togglePause(sessionId: string): { paused: boolean } {
    if (live?.sessionId !== sessionId) return { paused: true };
    live.paused = !live.paused;
    broadcast(EVENTS.sessionState, { status: 'live', paused: live.paused });
    return { paused: live.paused };
  },

  /** Pause/resume whichever session is currently live (for overlay + hotkey,
   *  which don't carry a session id). No-op when nothing is live. */
  togglePauseActive(): { paused: boolean; active: boolean } {
    if (!live) return { paused: false, active: false };
    return { ...this.togglePause(live.sessionId), active: true };
  },

  /** Stop whichever session is currently live (for the Cue Card, which doesn't
   *  carry a session id). No-op when nothing is live. The 'stopped' sessionState
   *  broadcast tears down the dashboard store + mic too. */
  stopActive(): { stopped: boolean } {
    if (!live) return { stopped: false };
    this.stop(live.sessionId);
    return { stopped: true };
  },

  /** Chunked STT fallback (used only if Realtime is unavailable). */
  async ingestAudio(sessionId: string, audio: ArrayBuffer, mime: string): Promise<void> {
    if (!live || live.sessionId !== sessionId || live.paused || live.busy) return;
    live.busy = true;
    try {
      const text = (await transcribeChunk(audio, mime)).trim();
      if (text) await this.processFinalTranscript(sessionId, text);
    } catch (e) {
      log.error('ingestAudio failed', e);
      broadcast(EVENTS.sessionError, { message: 'Transcription failed.' });
    } finally {
      if (live) live.busy = false;
    }
  },

  /** Manual or auto-detected question: register the question row + broadcast it,
   *  then stream the grounded answer. */
  async answerQuestion(
    sessionId: string,
    questionText: string,
    type = 'behavioral',
    confidence = 1,
    strategy = '',
    transcriptChunkId: string | null = null,
  ): Promise<{ questionId: string }> {
    const session = db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) throw new Error('Session not found');

    // Cancel any in-flight answer BEFORE we broadcast the new question (which
    // clears the Cue Card answer), so a late token from the old stream can't
    // land in the freshly-cleared answer.
    if (live?.answerAbort) live.answerAbort.abort();

    const questionId = crypto.randomUUID();
    db()
      .insert(schema.detectedQuestions)
      .values({
        id: questionId,
        sessionId,
        text: questionText,
        type,
        confidence,
        strategy,
        transcriptChunkId,
      })
      .run();
    broadcast(EVENTS.questionDetected, {
      id: questionId,
      sessionId,
      text: questionText,
      type,
      confidence,
      strategy,
      createdAt: Date.now(),
    });
    // Remember this question so the Cue Card can re-generate it (length/format/
    // pronunciation toggles) by reusing THIS question row — no duplicate line.
    if (live) live.lastQuestion = { questionId, text: questionText };

    return this.generateAnswer(sessionId, questionId, questionText);
  },

  /** Stream (or re-stream) the grounded answer for an already-registered question.
   *  Reused by regenerateActive so toggling length/format doesn't insert a new
   *  question row or push a duplicate transcript line. */
  async generateAnswer(
    sessionId: string,
    questionId: string,
    questionText: string,
  ): Promise<{ questionId: string }> {
    const session = db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) throw new Error('Session not found');
    const profile = profilesRepo.get(session.profileId);
    if (!profile) throw new Error('Profile not found');

    let answer = '';
    let tokens: { prompt: number; completion: number } | null = null;
    let meta: Record<string, unknown> = {};
    // Invalidate any in-flight follow-up prediction from a previous take of this
    // question — bumped at STREAM START so even an aborted regenerate supersedes.
    const followupGen = (followupGeneration.get(questionId) ?? 0) + 1;
    followupGeneration.set(questionId, followupGen);
    const abort = new AbortController();
    if (live) {
      live.answering = true;
      live.answerAbort = abort;
    }
    try {
      // Retrieval (an embeddings call) is INSIDE the try so a failure here is surfaced
      // + un-wedges the card too — not just streamAnswer failures.
      const context = await retrieve(profile.id, questionText, 5, session.jobId);
      // Transparency: tell the UI exactly what was sent to OpenAI for this question.
      broadcast(EVENTS.contextSent, { questionId, question: questionText, chunks: context });
      for await (const ev of streamAnswer({
        question: questionText,
        contextChunks: context,
        profile,
        // Answer format + pronunciation are chosen per run (this round) and can be
        // toggled live from the Cue Card.
        format: live?.answerFormat ?? 'key_points',
        pronunciation: live?.pronunciation ?? false,
        interviewType: (live?.interviewType ?? session.interviewType) as InterviewType,
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
      // Aborted by clear/regenerate — drop this partial answer, but still tell the Cue
      // Card this question is done so its card stops showing the streaming cursor. (With
      // per-card regenerate + history, the aborted card may be a DIFFERENT, still-visible
      // one than the card being regenerated.)
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
      if (live && live.answerAbort === abort) {
        live.answering = false;
        live.answerAbort = null;
      }
    }

    // Replace any prior answer for this question so a regenerate overwrites rather
    // than appends. Done ONLY after the stream completes (both statements are
    // synchronous + adjacent), so an aborted regenerate never deletes the existing
    // answer without a replacement.
    db().delete(schema.aiAnswers).where(eq(schema.aiAnswers.questionId, questionId)).run();
    db()
      .insert(schema.aiAnswers)
      .values({
        id: crypto.randomUUID(),
        questionId,
        directAnswer: answer,
        riskWarning: (meta.riskWarning as string) ?? null,
        model: 'answer',
        tokens: tokens ? JSON.stringify(tokens) : null,
      })
      .run();

    broadcast(EVENTS.answerDone, { questionId });

    // Predict the interviewer's likely follow-up AFTER the answer is done — a
    // cheap classify-tier call that can never touch first-token latency.
    // Fire-and-forget: a failed prediction is silent. Skipped for mock
    // rehearsals (the AI interviewer generates its own next question anyway).
    if (answer && live && !live.isMock && live.sessionId === sessionId) {
      const interviewType = live.interviewType;
      void predictFollowup({ question: questionText, answer, interviewType })
        .then((followup) => {
          if (!followup) return;
          // Stale guards: a regenerate superseded this prediction, or the
          // session changed while it was in flight — drop it silently.
          if (followupGeneration.get(questionId) !== followupGen) return;
          if (!live || live.sessionId !== sessionId) return;
          db()
            .update(schema.aiAnswers)
            .set({ followupQuestion: followup })
            .where(eq(schema.aiAnswers.questionId, questionId))
            .run();
          broadcast(EVENTS.answerFollowup, { questionId, followup }, ['overlay']);
        })
        .catch((e) => log.warn('followup prediction failed', e));
    }

    return { questionId };
  },

  /** Update the live answer preferences (interview type / format / length /
   *  pronunciation) for the active session. Type is dynamic — switching it mid-
   *  interview just changes how subsequent answers are framed (each question is
   *  still classified + tagged independently). Takes effect on the next (or
   *  regenerated) answer. */
  /** The live session's current Answer Format (null when idle) — read by the coding
   *  solver so its four-beat delivery follows the Cue Card's format toggle. */
  activeAnswerFormat(): AnswerFormat | null {
    return live?.answerFormat ?? null;
  },

  setAnswerPrefs(prefs: {
    interviewType?: InterviewType;
    format?: AnswerFormat;
    pronunciation?: boolean;
  }): { interviewType: InterviewType; format: AnswerFormat; pronunciation: boolean } {
    // No active session (idle Cue Card): no-op with sensible defaults.
    if (!live) {
      return {
        interviewType: prefs.interviewType ?? 'general',
        format: prefs.format ?? 'key_points',
        pronunciation: prefs.pronunciation ?? false,
      };
    }
    if (prefs.interviewType !== undefined) {
      live.interviewType = prefs.interviewType;
      // Persist the latest type on the session row so the list/Reports reflect it.
      db()
        .update(schema.sessions)
        .set({ interviewType: prefs.interviewType })
        .where(eq(schema.sessions.id, live.sessionId))
        .run();
    }
    if (prefs.format !== undefined) live.answerFormat = prefs.format;
    if (prefs.pronunciation !== undefined) live.pronunciation = prefs.pronunciation;
    return {
      interviewType: live.interviewType,
      format: live.answerFormat,
      pronunciation: live.pronunciation,
    };
  },

  /** Re-answer a question for the active session — a SPECIFIC one by id (the Cue
   *  Card's per-card "Regenerate" button) or, with no id, the last question (after
   *  toggling format/pronunciation). Reuses the SAME question row — no new transcript
   *  line or DB question. */
  async regenerate(questionId?: string): Promise<{ regenerated: boolean }> {
    if (!live) return { regenerated: false };
    let qid: string;
    let text: string;
    if (questionId) {
      // A specific card: pull its text from its question row (any question in this session).
      const row = db()
        .select()
        .from(schema.detectedQuestions)
        .where(eq(schema.detectedQuestions.id, questionId))
        .get();
      if (!row) return { regenerated: false }; // e.g. an ad-hoc coding-solve card (not persisted)
      qid = questionId;
      text = row.text;
    } else if (live.lastQuestion) {
      qid = live.lastQuestion.questionId;
      text = live.lastQuestion.text;
    } else {
      return { regenerated: false };
    }
    // Abort the current answer BEFORE clearing the Cue Card, so a late token from
    // the aborted stream can't land in the cleared answer.
    if (live.answerAbort) live.answerAbort.abort();
    // Clear that question's answer in the Cue Card (without touching the transcript).
    broadcast(EVENTS.answerReset, { questionId: qid });
    await this.generateAnswer(live.sessionId, qid, text);
    return { regenerated: true };
  },

  /** Clear the current answer: abort any in-flight stream for the active session.
   *  The Cue Card clears its own view; this stops tokens from continuing to arrive. */
  clearAnswerActive(): { cleared: boolean } {
    if (live?.answerAbort) live.answerAbort.abort();
    return { cleared: true };
  },

  /** Manually ask a question for the active session (Cue Card "Ask" box). */
  async askActive(questionText: string): Promise<{ ok: boolean }> {
    const text = questionText.trim();
    if (!live || !text) return { ok: false };
    await this.answerQuestion(live.sessionId, text);
    return { ok: true };
  },

  /** Enable/disable auto-answering of the interviewer for the active session. Coding
   *  sessions default to disabled (listen-only). Enabling it also answers the question
   *  the interviewer just asked (remembered while suppressed), so toggling on catches up. */
  setAnsweringActive(enabled: boolean): { enabled: boolean; answered: boolean } {
    if (!live) return { enabled: true, answered: false };
    live.suppressAnswers = !enabled;
    if (enabled && live.pendingQuestionText) {
      const text = live.pendingQuestionText;
      live.pendingQuestionText = null;
      void this.answerQuestion(live.sessionId, text).catch(() => {});
      return { enabled, answered: true };
    }
    return { enabled, answered: false };
  },
};
