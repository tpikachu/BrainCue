import { engine } from '../engine/engine';
import type { AnswerFormat, InterviewType, Session } from '@shared/types';

/**
 * Backward-compatible FACADE over the conversation engine.
 *
 * v1's 672-line pipeline lived here; it now lives in services/engine/
 * (EngineSession + Engine), configured by modes/interview.mode.ts. Every
 * exported method keeps its exact v1 signature and behavior — the IPC
 * handlers, mock/sparring managers, and the coding solver all call this
 * unchanged, and sessionManager.parity.test.ts pins the semantics. New code
 * should import the engine directly; this facade exists so the extraction PR
 * changes zero call sites.
 */
export const sessionManager = {
  /** Set up the live state + Realtime transcriber for a session row (shared by
   *  start and resume; mock rehearsals pass isMock). Tears down any previous
   *  live session first. */
  goLive(opts: {
    sessionId: string;
    profileId: string;
    jobId: string | null;
    interviewType: InterviewType;
    answerFormat: AnswerFormat;
    language: string;
    isMock?: boolean;
  }): void {
    engine.begin({
      sessionId: opts.sessionId,
      profileId: opts.profileId,
      packId: opts.jobId,
      interviewType: opts.interviewType,
      answerFormat: opts.answerFormat,
      language: opts.language,
      ephemeral: opts.isMock,
    });
  },

  start(
    profileId: string,
    interviewType: InterviewType,
    jobId: string | null = null,
    answerFormat: AnswerFormat = 'key_points',
  ): Session {
    return engine.start(profileId, interviewType, jobId, answerFormat);
  },

  resume(sessionId: string, answerFormat: AnswerFormat = 'key_points'): Session {
    return engine.resume(sessionId, answerFormat);
  },

  feedRealtimeAudio(sessionId: string, pcm: ArrayBuffer): void {
    engine.feedRealtimeAudio(sessionId, pcm);
  },

  async processFinalTranscript(sessionId: string, text: string): Promise<void> {
    await engine.processFinalTranscript(sessionId, text);
  },

  async ingestAudio(sessionId: string, audio: ArrayBuffer, mime: string): Promise<void> {
    await engine.ingestAudio(sessionId, audio, mime);
  },

  stop(sessionId: string): Session {
    return engine.stop(sessionId);
  },

  shutdown(): void {
    engine.shutdown();
  },

  togglePause(sessionId: string): { paused: boolean } {
    return engine.togglePause(sessionId);
  },

  togglePauseActive(): { paused: boolean; active: boolean } {
    return engine.togglePauseActive();
  },

  stopActive(): { stopped: boolean } {
    return engine.stopActive();
  },

  async answerQuestion(
    sessionId: string,
    questionText: string,
    type = 'behavioral',
    confidence = 1,
    strategy = '',
    transcriptChunkId: string | null = null,
  ): Promise<{ questionId: string }> {
    return engine.answerQuestion(sessionId, questionText, type, confidence, strategy, transcriptChunkId);
  },

  activeAnswerFormat(): AnswerFormat | null {
    return engine.activeAnswerFormat();
  },

  setAnswerPrefs(prefs: {
    interviewType?: InterviewType;
    format?: AnswerFormat;
    pronunciation?: boolean;
  }): { interviewType: InterviewType; format: AnswerFormat; pronunciation: boolean } {
    return engine.setAnswerPrefs(prefs);
  },

  async regenerate(questionId?: string): Promise<{ regenerated: boolean }> {
    return engine.regenerate(questionId);
  },

  clearAnswerActive(): { cleared: boolean } {
    return engine.clearAnswerActive();
  },

  async askActive(questionText: string): Promise<{ ok: boolean }> {
    return engine.askActive(questionText);
  },

  setAnsweringActive(enabled: boolean): { enabled: boolean; answered: boolean } {
    return engine.setAnsweringActive(enabled);
  },
};
