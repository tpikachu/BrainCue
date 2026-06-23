import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { transcribeChunk } from '../openai/transcription';
import { classifyQuestion } from '../openai/questions';
import { streamAnswer } from '../openai/answer';
import { retrieve } from '../rag/retriever';
import { RealtimeTranscriber } from '../openai/realtime';
import { getOverlayWindow, showOverlay } from '../../windows/overlayWindow';
import { log } from '../security/logger';
import type { AnswerStyle, InterviewType, Session } from '@shared/types';

interface LiveState {
  sessionId: string;
  profileId: string;
  jobId: string | null;
  interviewType: InterviewType;
  answerStyle: AnswerStyle;
  paused: boolean;
  busy: boolean; // a chunk is currently being processed (chunked fallback path)
  answering: boolean; // an answer is currently being generated (avoid overlap)
  transcriber: RealtimeTranscriber | null;
}

let live: LiveState | null = null;

function toSession(r: typeof schema.sessions.$inferSelect): Session {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.jobId,
    interviewType: r.interviewType as InterviewType,
    status: r.status as Session['status'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
  };
}

export const sessionManager = {
  start(
    profileId: string,
    interviewType: InterviewType,
    answerStyle: AnswerStyle,
    jobId: string | null = null,
  ): Session {
    if (!profilesRepo.get(profileId)) throw new Error('Profile not found');
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({ id, profileId, jobId, interviewType, status: 'live', startedAt: Date.now() })
      .run();
    const profile = profilesRepo.get(profileId)!;
    live = {
      sessionId: id,
      profileId,
      jobId,
      interviewType,
      answerStyle,
      paused: false,
      busy: false,
      answering: false,
      transcriber: null,
    };
    showOverlay();

    // Streaming STT via Realtime API. Partials show live; finals are precise.
    const transcriber = new RealtimeTranscriber(
      {
        onDelta: (text) =>
          broadcast(EVENTS.transcriptDelta, { text, isFinal: false, speaker: 'interviewer' }),
        onFinal: (text) => void this.processFinalTranscript(id, text),
        onError: (message) => broadcast(EVENTS.sessionError, { message }),
      },
      profile.language || 'en',
    );
    transcriber.start();
    live.transcriber = transcriber;

    broadcast(EVENTS.sessionState, { status: 'live', paused: false });
    return toSession(db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()!);
  },

  /** Feed streaming PCM16 (24kHz mono) audio from the renderer to the transcriber. */
  feedRealtimeAudio(sessionId: string, pcm: ArrayBuffer): void {
    if (!live || live.sessionId !== sessionId || live.paused) return;
    live.transcriber?.appendAudio(Buffer.from(pcm).toString('base64'));
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

    // Don't pile up overlapping answers — if one is already streaming, just keep
    // transcribing. (The user can still ask manually.)
    if (live.answering) return;

    try {
      const classified = await classifyQuestion(text);
      if (classified.isQuestion && classified.confidence >= 0.4 && !live.answering) {
        await this.answerQuestion(
          sessionId,
          text,
          classified.type,
          classified.confidence,
          classified.strategy,
          tcId,
        );
      }
    } catch (e) {
      log.error('processFinalTranscript failed', e);
    }
  },

  stop(sessionId: string): Session {
    db()
      .update(schema.sessions)
      .set({ status: 'stopped', endedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    if (live?.sessionId === sessionId) {
      live.transcriber?.stop();
      live = null;
    }
    broadcast(EVENTS.sessionState, { status: 'stopped', paused: false });
    getOverlayWindow()?.hide(); // close the floating overlay when the session ends
    return toSession(
      db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!,
    );
  },

  /** Release the live transcription websocket on app exit so its socket/helper
   *  process doesn't linger. Does not touch the DB (the session row keeps its
   *  last status). Safe to call when nothing is live. */
  shutdown(): void {
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

  /** Manual or auto-detected question -> RAG -> streamed grounded answer. */
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
    const profile = profilesRepo.get(session.profileId);
    if (!profile) throw new Error('Profile not found');

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

    const context = await retrieve(profile.id, questionText, 5, session.jobId);
    // Transparency: tell the UI exactly what was sent to OpenAI for this question.
    broadcast(EVENTS.contextSent, { questionId, question: questionText, chunks: context });

    let answer = '';
    let tokens: { prompt: number; completion: number } | null = null;
    let meta: Record<string, unknown> = {};
    if (live) live.answering = true;
    try {
      for await (const ev of streamAnswer({
        question: questionText,
        contextChunks: context,
        profile,
        // Interview type + answer style are chosen per run (this round).
        style: live?.answerStyle ?? 'concise',
        interviewType: (live?.interviewType ?? session.interviewType) as InterviewType,
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
    } finally {
      if (live) live.answering = false;
    }

    db()
      .insert(schema.aiAnswers)
      .values({
        id: crypto.randomUUID(),
        questionId,
        directAnswer: answer,
        talkingPoints: JSON.stringify((meta.talkingPoints as string[]) ?? []),
        resumeMatch: (meta.resumeMatch as string) ?? null,
        star: meta.star ? JSON.stringify(meta.star) : null,
        clarifyingQuestion: (meta.clarifyingQuestion as string) ?? null,
        riskWarning: (meta.riskWarning as string) ?? null,
        followupQuestion: (meta.followupQuestion as string) ?? null,
        model: 'answer',
        tokens: tokens ? JSON.stringify(tokens) : null,
      })
      .run();

    broadcast(EVENTS.answerDone, { questionId });
    return { questionId };
  },
};
