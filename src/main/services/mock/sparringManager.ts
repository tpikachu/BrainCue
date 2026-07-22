import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { generateQuestion, type QaTurn } from '../openai/interviewer';
import { speak, type TtsVoice } from '../openai/tts';
import { transcribeChunk } from '../openai/transcription';
import { evaluateAnswer } from '../openai/feedback';
import { apiKeyStore } from '../security/apiKey';
import { QUESTION_TYPE_BY_INTERVIEW } from './mockManager';
import type { InterviewType, SparringFeedback } from '@shared/types';

const MAX_QUESTIONS = 6;

interface SparringState {
  id: string; // doubles as the persisted sessions.id (kind 'sparring')
  profileId: string;
  jobId: string | null;
  interviewType: InterviewType;
  voice: TtsVoice;
  history: QaTurn[]; // each turn: { q, a } — a is filled in once the candidate answers
  questionIds: string[]; // detected_questions row per turn (parallel to history)
}

// One active Sparring round at a time (mirrors mockManager's single `mock`).
// The Practice Loop (v1.5): every drill persists as a session of kind
// 'sparring' — questions, spoken answers, and per-answer coaching land in the
// DB AS THEY HAPPEN, so practice accumulates into Reports trends instead of
// evaporating when the round ends.
let spar: SparringState | null = null;

const label = (c: string) => c.replace(/_/g, ' ');

/** Close out a sparring session row: stamp stopped/endedAt and assemble its
 *  report LOCALLY from the per-answer coaching (no extra model call — the
 *  answers were already coached one by one). A drill with no questions at all
 *  leaves no trace; one with questions but no answers persists without a
 *  report. Also used to self-heal rows a crash left 'live'. */
function finalizeSparringSession(sessionId: string): void {
  const questionCount = sessionsRepo.questionCount(sessionId);
  const hasFeedback =
    db()
      .select({ id: schema.answerFeedback.id })
      .from(schema.answerFeedback)
      .where(eq(schema.answerFeedback.sessionId, sessionId))
      .all().length > 0;
  if (questionCount === 0 && !hasFeedback) {
    sessionsRepo.delete(sessionId);
    return;
  }
  db()
    .update(schema.sessions)
    .set({ status: 'stopped', endedAt: Date.now() })
    .where(eq(schema.sessions.id, sessionId))
    .run();
  buildSparringReport(sessionId);
}

/** Assemble (and persist) a drill's report from its answer_feedback rows — no
 *  model call. Returns null when the drill has no coached answers. Exported so
 *  the report service can build it on demand for a drill that was never
 *  finalized (e.g. the app quit from the Sparring page) instead of running the
 *  live-interview LLM generator against answers sparring never wrote. */
export function buildSparringReport(sessionId: string) {
  const rows = db()
    .select()
    .from(schema.answerFeedback)
    .where(eq(schema.answerFeedback.sessionId, sessionId))
    .all();
  if (rows.length === 0) return null;

  const parse = (s: string | null): string[] => {
    try {
      return s ? (JSON.parse(s) as string[]) : [];
    } catch {
      return [];
    }
  };
  const dedupe = (arr: string[]) => [...new Set(arr)].slice(0, 5);
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;

  const byCompetency = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.competency) continue;
    const c = byCompetency.get(r.competency) ?? { sum: 0, n: 0 };
    c.sum += r.rating;
    c.n += 1;
    byCompetency.set(r.competency, c);
  }
  const ranked = [...byCompetency.entries()]
    .map(([c, { sum, n }]) => ({ c, avg: sum / n }))
    .sort((a, b) => b.avg - a.avg);
  const spread =
    ranked.length > 1
      ? ` Strongest: **${label(ranked[0].c)}** (${ranked[0].avg.toFixed(1)}); focus next: ` +
        `**${label(ranked[ranked.length - 1].c)}** (${ranked[ranked.length - 1].avg.toFixed(1)}).`
      : '';
  const summary =
    `**Practice drill** — ${rows.length} answer${rows.length === 1 ? '' : 's'} coached, ` +
    `average **${avg.toFixed(1)}/5**.${spread}`;

  const questionText = new Map(
    db()
      .select({ id: schema.detectedQuestions.id, text: schema.detectedQuestions.text })
      .from(schema.detectedQuestions)
      .where(eq(schema.detectedQuestions.sessionId, sessionId))
      .all()
      .map((q) => [q.id, q.text] as const),
  );
  return sessionsRepo.saveReport({
    sessionId,
    summary,
    strengths: dedupe(rows.flatMap((r) => parse(r.strengths))),
    improvements: dedupe(rows.flatMap((r) => parse(r.improvements))),
    perQuestion: rows.map((r) => ({
      question: questionText.get(r.questionId) ?? '(question)',
      assessment: `[${r.rating}/5] ${r.verdict}`.trim(),
    })),
  });
}

/** Generate + speak the interviewer's next question, recording it in history
 *  AND as a detected_questions row (so reports/typeCounts see it). */
async function ask(): Promise<{ question: string; audioBase64: string }> {
  // Capture the state object: `spar` is module-global and the awaits below take
  // seconds — end()/start() during them must not make us write into a replaced
  // drill. Every post-await step checks the capture is still current.
  const s = spar;
  if (!s) throw new Error('No active sparring session.');
  const profile = profilesRepo.get(s.profileId);
  if (!profile) throw new Error('Profile not found.');
  const job = s.jobId ? jobsRepo.get(s.jobId) : null;

  const question = await generateQuestion(profile, s.history, job, s.interviewType);
  // Only commit the question to history AFTER TTS succeeds — a transient speak()
  // failure must not permanently consume a turn slot (which would skip questions,
  // end the round early, and pollute follow-up context with an unanswered turn).
  const audio = await speak(question, s.voice);
  if (spar !== s) throw new Error('The sparring session ended.');
  s.history.push({ q: question, a: '' });
  const questionId = crypto.randomUUID();
  db()
    .insert(schema.detectedQuestions)
    .values({
      id: questionId,
      sessionId: s.id,
      text: question,
      type: QUESTION_TYPE_BY_INTERVIEW[s.interviewType],
      confidence: 1,
      strategy: 'sparring',
    })
    .run();
  s.questionIds.push(questionId);
  return { question, audioBase64: audio.toString('base64') };
}

/** Decode base64 audio (from the renderer) into an ArrayBuffer for transcription. */
function decodeAudio(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export const sparringManager = {
  /** Finalize any sparring session a crash/quit left 'live' (stamp + report),
   *  so Reports never shows a phantom in-progress drill and the sidebar's
   *  live counter can't be haunted across launches. Runs at app boot and
   *  again before each new drill. */
  healStrays(): void {
    const strays = db()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.kind, 'sparring'), eq(schema.sessions.status, 'live')))
      .all();
    for (const s of strays) {
      if (spar?.id === s.id) continue; // never finalize the drill that's actually running
      finalizeSparringSession(s.id);
    }
  },

  /** Begin a two-way voice mock: ask the first question aloud. */
  async start(
    profileId: string,
    voice: TtsVoice,
    jobId: string | null = null,
    interviewType: InterviewType = 'general',
  ) {
    const profile = profilesRepo.get(profileId);
    if (!profile) throw new Error('Profile not found.');
    if (!apiKeyStore.isPresent())
      throw new Error('Add your OpenAI API key in Settings to start a sparring session.');

    this.healStrays();

    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({
        id,
        profileId,
        packId: jobId,
        mode: 'practice',
        kind: 'sparring',
        interviewType,
        status: 'live',
        startedAt: Date.now(),
      })
      .run();
    spar = { id, profileId, jobId, interviewType, voice, history: [], questionIds: [] };

    try {
      const q = await ask();
      return { sessionId: spar.id, ...q, index: 1, total: MAX_QUESTIONS };
    } catch (e) {
      // First question failed (quota/network/invalid key): leave no empty session.
      finalizeSparringSession(id); // zero questions → row deleted
      spar = null;
      throw e;
    }
  },

  /** Transcribe the candidate's spoken answer to the current question, persist it
   *  (transcript + per-answer coaching), and return the feedback. */
  async answer(
    sessionId: string,
    audioBase64: string,
    mime: string,
  ): Promise<{ transcript: string; feedback: SparringFeedback }> {
    // Capture the state object at entry: the two awaits below take seconds, and
    // "End sparring" (or end + a fresh start) can run in between. Writing with
    // a re-read of the global would land this answer in the WRONG drill.
    const s = spar;
    if (!s || s.id !== sessionId) throw new Error('No active sparring session.');
    const current = s.history[s.history.length - 1];
    const questionId = s.questionIds[s.questionIds.length - 1];
    if (!current || !questionId) throw new Error('No question to answer yet.');

    const profile = profilesRepo.get(s.profileId);
    if (!profile) throw new Error('Profile not found.');
    const job = s.jobId ? jobsRepo.get(s.jobId) : null;

    const transcript = (await transcribeChunk(decodeAudio(audioBase64), mime)).trim();
    if (spar !== s) throw new Error('The sparring session ended — answer discarded.');
    current.a = transcript;
    const feedback = await evaluateAnswer({
      question: current.q,
      answer: transcript,
      profile,
      job,
      interviewType: s.interviewType,
    });
    if (spar !== s) throw new Error('The sparring session ended — answer discarded.');
    // Persist AFTER both model calls succeed (nothing half-written on failure):
    // the spoken answer into the session transcript, the coaching into
    // answer_feedback — replacing any previous take on a re-answer.
    db()
      .insert(schema.transcriptChunks)
      .values({
        id: crypto.randomUUID(),
        sessionId: s.id,
        speaker: 'candidate',
        text: transcript,
        isFinal: 1,
      })
      .run();
    db()
      .delete(schema.answerFeedback)
      .where(eq(schema.answerFeedback.questionId, questionId))
      .run();
    db()
      .insert(schema.answerFeedback)
      .values({
        id: crypto.randomUUID(),
        sessionId: s.id,
        questionId,
        answerTranscript: transcript,
        rating: feedback.rating,
        verdict: feedback.verdict,
        strengths: JSON.stringify(feedback.strengths),
        improvements: JSON.stringify(feedback.improvements),
        tip: feedback.tip || null,
        competency: feedback.competency,
      })
      .run();
    return { transcript, feedback };
  },

  /** Ask the next question (history-aware, so it can follow up) or signal done. */
  async next(sessionId: string) {
    if (!spar || spar.id !== sessionId) throw new Error('No active sparring session.');
    if (spar.history.length >= MAX_QUESTIONS) {
      return { done: true as const, index: spar.history.length, total: MAX_QUESTIONS };
    }
    const q = await ask();
    return { done: false as const, ...q, index: spar.history.length, total: MAX_QUESTIONS };
  },

  /** End the drill: finalize the session row + assemble its report from the
   *  per-answer coaching. The drill lives on in Reports. */
  end(sessionId: string) {
    if (spar?.id === sessionId) {
      finalizeSparringSession(sessionId);
      spar = null;
    }
  },
};
