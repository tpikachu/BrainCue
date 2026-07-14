import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { generateQuestion, type QaTurn } from '../openai/interviewer';
import { speak, type TtsVoice } from '../openai/tts';
import { sessionManager } from '../session/sessionManager';
import { apiKeyStore } from '../security/apiKey';
import type { InterviewType, QuestionType, Session } from '@shared/types';

const MAX_QUESTIONS = 6;

// Mock questions are generated for the chosen interview type, so tag each detected
// question with a matching QuestionType (used by the live answer prompt + any tags).
export const QUESTION_TYPE_BY_INTERVIEW: Record<InterviewType, QuestionType> = {
  behavioral: 'behavioral',
  technical: 'technical_concept',
  coding: 'coding',
  system_design: 'system_design',
  general: 'behavioral',
};

interface MockState {
  sessionId: string;
  profileId: string;
  jobId: string | null;
  interviewType: InterviewType;
  voice: TtsVoice;
  history: QaTurn[]; // prior questions, to steer variety
  questionType: QuestionType;
}

let mock: MockState | null = null;

function toSession(r: typeof schema.sessions.$inferSelect): Session {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.jobId,
    kind: r.kind as Session['kind'],
    interviewType: r.interviewType as Session['interviewType'],
    status: r.status as Session['status'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
  };
}

/** Generate the interviewer's next question, speak it (TTS), and stream a grounded
 *  answer into the Cue Card via the live pipeline — so a mock doubles as a real,
 *  end-to-end test of the copilot. */
async function ask(): Promise<{ question: string; audioBase64: string }> {
  if (!mock) throw new Error('No active mock interview');
  const profile = profilesRepo.get(mock.profileId);
  if (!profile) throw new Error('Profile not found');
  const job = mock.jobId ? jobsRepo.get(mock.jobId) : null;

  const question = await generateQuestion(profile, mock.history, job, mock.interviewType);

  // Stream the grounded answer to the Cue Card (don't await — let TTS play in
  // parallel) and synthesize the interviewer's voice. The question is committed to
  // history only AFTER TTS succeeds — a transient speak() failure must not consume a
  // turn slot or pollute follow-up context (same rule as sparringManager.ask).
  void sessionManager.answerQuestion(mock.sessionId, question, mock.questionType).catch(() => {});
  const audio = await speak(question, mock.voice);
  mock.history.push({ q: question, a: '' });
  return { question, audioBase64: audio.toString('base64') };
}

export const mockManager = {
  /** Start a mock rehearsal: open a (non-persisted) live session so the Cue Card
   *  is fully functional, then ask the first question. */
  async start(
    profileId: string,
    voice: TtsVoice,
    jobId: string | null = null,
    interviewType: InterviewType = 'general',
  ) {
    if (!apiKeyStore.isPresent())
      throw new Error('Add your OpenAI API key in Settings to start a mock interview.');
    const profile = profilesRepo.get(profileId);
    if (!profile) throw new Error('Profile not found');
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({ id, profileId, jobId, kind: 'mock', interviewType, status: 'live', startedAt: Date.now() })
      .run();
    sessionManager.goLive({
      sessionId: id,
      profileId,
      jobId,
      interviewType,
      answerFormat: 'key_points',
      language: profile.language,
      isMock: true,
    });
    mock = {
      sessionId: id,
      profileId,
      jobId,
      interviewType,
      voice,
      history: [],
      questionType: QUESTION_TYPE_BY_INTERVIEW[interviewType],
    };

    try {
      const q = await ask();
      const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      // The user can press Stop while the first question is being generated/spoken
      // (the overlay is already live) — the mock row is deleted by then.
      if (!row) throw new Error('Mock interview was stopped');
      return { session: toSession(row), ...q, index: 1, total: MAX_QUESTIONS };
    } catch (e) {
      // First question failed (quota/network/invalid key): tear down everything we
      // just set up — stop() on a mock hides the overlay, broadcasts 'stopped', and
      // DELETES the row — so no phantom "live" session outlives the error. Best-
      // effort: the user may have already stopped it, which must not mask `e`.
      try {
        sessionManager.stop(id);
      } catch {
        /* already stopped/deleted by the user */
      }
      mock = null;
      throw e;
    }
  },

  /** Ask the next question (or signal done). */
  async next(sessionId: string) {
    if (!mock || mock.sessionId !== sessionId) throw new Error('No active mock interview');
    if (mock.history.length >= MAX_QUESTIONS) {
      return { done: true as const, index: mock.history.length, total: MAX_QUESTIONS };
    }
    const q = await ask();
    return { done: false as const, ...q, index: mock.history.length, total: MAX_QUESTIONS };
  },

  /** End the rehearsal — stops the live session, which (being a mock) is deleted,
   *  not saved. */
  end(sessionId: string) {
    try {
      sessionManager.stop(sessionId); // isMock → tears down + deletes, no save prompt
    } catch {
      /* already stopped (e.g. via the Cue Card) — the row is gone; just release */
    }
    if (mock?.sessionId === sessionId) mock = null;
  },
};
