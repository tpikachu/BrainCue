import { eq } from 'drizzle-orm';
import { db, schema } from '../../../db';
import type { ContributionKind, Speaker } from '@shared/types';

/**
 * All engine persistence in one place. The interview tables
 * (transcript_chunks / detected_questions / ai_answers) keep their exact v1
 * write semantics — the parity suite pins them — and every completed
 * generation is ALSO written to the generic `contributions` table (dual-write)
 * so reports and the contribution-cards overlay can consume one shape.
 * Contributions mirror ai_answers' semantics for now: only completed streams
 * get a row (aborted/failed streams never did); the richer lifecycle statuses
 * arrive when the overlay consumes contributions directly.
 */
export const enginePersistence = {
  sessionRow(sessionId: string) {
    return db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  },

  finalTranscript(sessionId: string, speaker: Speaker, text: string): string {
    const id = crypto.randomUUID();
    db()
      .insert(schema.transcriptChunks)
      .values({ id, sessionId, speaker, text, isFinal: 1 })
      .run();
    return id;
  },

  insertQuestion(opts: {
    sessionId: string;
    text: string;
    type: string;
    confidence: number;
    strategy: string;
    transcriptChunkId: string | null;
  }): string {
    const id = crypto.randomUUID();
    db()
      .insert(schema.detectedQuestions)
      .values({ id, ...opts })
      .run();
    return id;
  },

  questionText(questionId: string): string | null {
    const row = db()
      .select()
      .from(schema.detectedQuestions)
      .where(eq(schema.detectedQuestions.id, questionId))
      .get();
    return row?.text ?? null;
  },

  /** Replace any prior answer for this question so a regenerate overwrites
   *  rather than appends. Both statements are synchronous + adjacent, so an
   *  aborted regenerate never deletes the existing answer without a
   *  replacement (the caller only invokes this AFTER a stream completes). */
  replaceAnswer(opts: {
    questionId: string;
    directAnswer: string;
    riskWarning: string | null;
    tokens: { prompt: number; completion: number } | null;
  }): void {
    db().delete(schema.aiAnswers).where(eq(schema.aiAnswers.questionId, opts.questionId)).run();
    db()
      .insert(schema.aiAnswers)
      .values({
        id: crypto.randomUUID(),
        questionId: opts.questionId,
        directAnswer: opts.directAnswer,
        riskWarning: opts.riskWarning,
        model: 'answer',
        tokens: opts.tokens ? JSON.stringify(opts.tokens) : null,
      })
      .run();
  },

  /** Persist the latest live-switched type on the session row so the
   *  list/Reports reflect it. */
  updateInterviewType(sessionId: string, interviewType: string): void {
    db()
      .update(schema.sessions)
      .set({ interviewType })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  },

  setFollowup(questionId: string, followup: string): void {
    db()
      .update(schema.aiAnswers)
      .set({ followupQuestion: followup })
      .where(eq(schema.aiAnswers.questionId, questionId))
      .run();
  },

  /** Dual-write: the generic contribution row for a completed generation. */
  insertContribution(opts: {
    sessionId: string;
    kind: ContributionKind;
    title: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    sourceRefs: { type: string; id: string }[] | null;
  }): string {
    const id = crypto.randomUUID();
    db()
      .insert(schema.contributions)
      .values({
        id,
        sessionId: opts.sessionId,
        kind: opts.kind,
        status: 'completed',
        title: opts.title,
        body: opts.body,
        meta: opts.meta ? JSON.stringify(opts.meta) : null,
        sourceRefs: opts.sourceRefs ? JSON.stringify(opts.sourceRefs) : null,
      })
      .run();
    return id;
  },
};
