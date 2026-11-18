import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../index';
import { transcriptOrder } from '../transcriptOrder';
import type {
  AiAnswer,
  Contribution,
  DetectedQuestion,
  PracticeStats,
  Session,
  SessionDetail,
  SessionListItem,
  SessionPage,
  SessionReport,
  StoryCompetency,
  TranscriptChunk,
} from '@shared/types';

const toSession = (r: typeof schema.sessions.$inferSelect): Session => ({
  id: r.id,
  profileId: r.profileId,
  jobId: r.packId, // shared field name kept for IPC compatibility
  activity: r.activity as Session['activity'],
  mode: r.mode as Session['mode'],
  kind: r.kind as Session['kind'],
  interviewType: r.interviewType as Session['interviewType'],
  status: r.status as Session['status'],
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  createdAt: r.createdAt,
});

const toAnswer = (r: typeof schema.aiAnswers.$inferSelect): AiAnswer => ({
  id: r.id,
  questionId: r.questionId,
  directAnswer: r.directAnswer,
  riskWarning: r.riskWarning,
  followupQuestion: r.followupQuestion,
  model: r.model,
  tokens: r.tokens ? JSON.parse(r.tokens) : null,
  createdAt: r.createdAt,
});

const toReport = (r: typeof schema.sessionReports.$inferSelect): SessionReport => ({
  id: r.id,
  sessionId: r.sessionId,
  summary: r.summary,
  strengths: r.strengths ? JSON.parse(r.strengths) : [],
  improvements: r.improvements ? JSON.parse(r.improvements) : [],
  perQuestion: r.perQuestion ? JSON.parse(r.perQuestion) : [],
  createdAt: r.createdAt,
});

/** The list row's columns: the session, its Space's title/company and the
 *  profile name (left-joined — a deleted Space reads as none). */
const listColumns = {
  id: schema.sessions.id,
  profileId: schema.sessions.profileId,
  jobId: schema.sessions.packId,
  activity: schema.sessions.activity,
  mode: schema.sessions.mode,
  kind: schema.sessions.kind,
  interviewType: schema.sessions.interviewType,
  status: schema.sessions.status,
  startedAt: schema.sessions.startedAt,
  endedAt: schema.sessions.endedAt,
  createdAt: schema.sessions.createdAt,
  jobTitle: schema.contextPacks.title,
  jobCompany: schema.contextPacks.company,
  profileName: schema.profiles.name,
};
interface ListRow {
  id: string;
  profileId: string;
  jobId: string | null;
  activity: string | null;
  mode: string;
  kind: string;
  interviewType: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  jobTitle: string | null;
  jobCompany: string | null;
  profileName: string | null;
}

/** Per-(session, question type) counts, for the given sessions only — so a
 *  page of history never scans every question in the database. */
function typeCountsFor(ids: string[] | null): Map<string, Record<string, number>> {
  const bySession = new Map<string, Record<string, number>>();
  if (ids && ids.length === 0) return bySession;
  const counts = db()
    .select({
      sessionId: schema.detectedQuestions.sessionId,
      type: schema.detectedQuestions.type,
      c: sql<number>`count(*)`,
    })
    .from(schema.detectedQuestions)
    .where(ids ? inArray(schema.detectedQuestions.sessionId, ids) : undefined)
    .groupBy(schema.detectedQuestions.sessionId, schema.detectedQuestions.type)
    .all();
  for (const r of counts) {
    const m = bySession.get(r.sessionId) ?? {};
    m[r.type] = r.c;
    bySession.set(r.sessionId, m);
  }
  return bySession;
}

function toListItem(r: ListRow, counts: Map<string, Record<string, number>>): SessionListItem {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.jobId ?? null,
    activity: r.activity as Session['activity'],
    mode: r.mode as Session['mode'],
    kind: r.kind as Session['kind'],
    interviewType: r.interviewType as Session['interviewType'],
    status: r.status as Session['status'],
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
    createdAt: r.createdAt,
    jobTitle: r.jobTitle ?? null,
    jobCompany: r.jobCompany ?? null,
    profileName: r.profileName ?? null,
    typeCounts: counts.get(r.id) ?? {},
  };
}

/** The detected question an answer card was written for, if any — the
 *  engine records it in meta.questionId and as a 'question' source ref. */
function linkedQuestion(r: { meta: string | null; sourceRefs: string | null }): string | null {
  try {
    const meta = r.meta ? (JSON.parse(r.meta) as { questionId?: unknown }) : null;
    if (meta && typeof meta.questionId === 'string') return meta.questionId;
    const refs = r.sourceRefs ? (JSON.parse(r.sourceRefs) as { type?: string; id?: string }[]) : [];
    return refs.find((x) => x?.type === 'question' && typeof x.id === 'string')?.id ?? null;
  } catch {
    return null;
  }
}

export const sessionsRepo = {
  /** One session row, or null. */
  get(id: string): Session | null {
    const r = db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    return r ? toSession(r) : null;
  },

  /**
   * One page of a profile's history, newest first — server-side LIMIT/OFFSET
   * with an exact count, searchable by Space title/company, activity, mode and
   * interview type. Sessions is a list that only grows.
   */
  page(opts: { profileId: string; query?: string; limit: number; offset: number }): SessionPage {
    const q = (opts.query ?? '').trim();
    const pat = `%${q}%`;
    const where: SQL | undefined = and(
      eq(schema.sessions.profileId, opts.profileId),
      q
        ? or(
            like(schema.contextPacks.title, pat),
            like(schema.contextPacks.company, pat),
            like(schema.sessions.activity, pat),
            like(schema.sessions.mode, pat),
            like(schema.sessions.interviewType, pat),
          )
        : undefined,
    );
    const rows = db()
      .select(listColumns)
      .from(schema.sessions)
      .leftJoin(schema.contextPacks, eq(schema.contextPacks.id, schema.sessions.packId))
      .leftJoin(schema.profiles, eq(schema.profiles.id, schema.sessions.profileId))
      .where(where)
      .orderBy(desc(schema.sessions.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
    const total =
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.sessions)
        .leftJoin(schema.contextPacks, eq(schema.contextPacks.id, schema.sessions.packId))
        .where(where)
        .get()?.c ?? 0;
    const counts = typeCountsFor(rows.map((r) => r.id));
    return { items: rows.map((r) => toListItem(r, counts)), total };
  },

  /**
   * Sessions with job (title/company) + profile name + a per-question type
   * breakdown, newest first.
   *
   * Scoped to ONE profile. It used to return every session in the database,
   * which was invisible while there was one profile and wrong the moment there
   * were two: Sessions and Insights showed other people's conversations, and
   * the practice averages on Insights mixed them together. `profileId` is
   * optional only for the callers that genuinely mean everything (data stats).
   */
  list(profileId?: string): SessionListItem[] {
    const rows = db()
      .select(listColumns)
      .from(schema.sessions)
      .leftJoin(schema.contextPacks, eq(schema.contextPacks.id, schema.sessions.packId))
      .leftJoin(schema.profiles, eq(schema.profiles.id, schema.sessions.profileId))
      .where(profileId ? eq(schema.sessions.profileId, profileId) : undefined)
      .orderBy(desc(schema.sessions.createdAt))
      .all();
    // One grouped query for the per-(session,type) question counts, so the
    // list can show "behavioral ×4 · coding ×2" without N detail loads.
    // (Every session's counts in one scan: an IN list of a long history could
    // exceed SQLite's bound-parameter limit. Paged history uses page().)
    const counts = typeCountsFor(null);
    return rows.map((r) => toListItem(r, counts));
  },

  detail(id: string): SessionDetail | null {
    const s = db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    if (!s) return null;

    const transcript = db()
      .select()
      .from(schema.transcriptChunks)
      .where(eq(schema.transcriptChunks.sessionId, id))
      .orderBy(...transcriptOrder())
      .all()
      .map<TranscriptChunk>((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        speaker: r.speaker as TranscriptChunk['speaker'],
        text: r.text,
        isFinal: !!r.isFinal,
        tStart: r.tStart,
        tEnd: r.tEnd,
        createdAt: r.createdAt,
      }));

    const questions = db()
      .select()
      .from(schema.detectedQuestions)
      .where(eq(schema.detectedQuestions.sessionId, id))
      .all()
      .map((q) => {
        const a = db()
          .select()
          .from(schema.aiAnswers)
          .where(eq(schema.aiAnswers.questionId, q.id))
          .get();
        const question: DetectedQuestion = {
          id: q.id,
          sessionId: q.sessionId,
          text: q.text,
          type: q.type as DetectedQuestion['type'],
          confidence: q.confidence,
          strategy: q.strategy,
          createdAt: q.createdAt,
          transcriptChunkId: q.transcriptChunkId ?? null,
        };
        return { ...question, answer: a ? toAnswer(a) : null };
      });

    const reportRow = db()
      .select()
      .from(schema.sessionReports)
      .where(eq(schema.sessionReports.sessionId, id))
      .get();

    // The other cards it produced (meetings, companion, saved voice quick
    // Asks), oldest first, as they appeared. An answer card is left out when
    // it was written for a detected question that HAS an answer row: that row
    // is the current answer — even when it is deliberately empty (a paused
    // correction clears it, M3) — and the card is an earlier copy, possibly of
    // an answer to wording that has since been corrected. Only a question with
    // no answer row at all keeps its linked card, to recover the answer. A
    // quick Ask has no detected question and no transcript, so it is the
    // session's only content and is always kept.
    const answered = new Set(questions.filter((q) => q.answer != null).map((q) => q.id));
    const cards = db()
      .select()
      .from(schema.contributions)
      .where(eq(schema.contributions.sessionId, id))
      .orderBy(asc(schema.contributions.createdAt))
      .all()
      .filter((r) => r.kind !== 'answer' || !answered.has(linkedQuestion(r) ?? ''))
      .map<Contribution>((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        kind: r.kind as Contribution['kind'],
        status: r.status as Contribution['status'],
        title: r.title,
        body: r.body,
        meta: r.meta ? JSON.parse(r.meta) : null,
        sourceRefs: r.sourceRefs ? JSON.parse(r.sourceRefs) : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

    const pack = s.packId
      ? db()
          .select({ title: schema.contextPacks.title, company: schema.contextPacks.company })
          .from(schema.contextPacks)
          .where(eq(schema.contextPacks.id, s.packId))
          .get()
      : undefined;

    return {
      ...toSession(s),
      transcript,
      questions,
      report: reportRow ? toReport(reportRow) : null,
      cards,
      spaceTitle: pack?.title ?? null,
      spaceCompany: pack?.company ?? null,
    };
  },

  getReport(sessionId: string): SessionReport | null {
    const r = db()
      .select()
      .from(schema.sessionReports)
      .where(eq(schema.sessionReports.sessionId, sessionId))
      .get();
    return r ? toReport(r) : null;
  },

  saveReport(report: Omit<SessionReport, 'id' | 'createdAt'>): SessionReport {
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessionReports)
      .values({
        id,
        sessionId: report.sessionId,
        summary: report.summary,
        strengths: JSON.stringify(report.strengths),
        improvements: JSON.stringify(report.improvements),
        perQuestion: JSON.stringify(report.perQuestion),
      })
      .onConflictDoUpdate({
        target: schema.sessionReports.sessionId,
        set: {
          summary: report.summary,
          strengths: JSON.stringify(report.strengths),
          improvements: JSON.stringify(report.improvements),
          perQuestion: JSON.stringify(report.perQuestion),
        },
      })
      .run();
    return this.getReport(report.sessionId)!;
  },

  /**
   * Drop a session's retrievable archive (docs/16-CONTINUITY.md).
   *
   * `chunks.source_id` is a plain column, not a foreign key, so SQLite cannot
   * cascade this for us — and an archive that outlives its session would keep
   * grounding answers in a conversation the user deleted. Embeddings DO cascade
   * from `chunks`, so the vector goes with it.
   */
  deleteArchive(sessionId: string): void {
    db()
      .delete(schema.chunks)
      .where(and(eq(schema.chunks.sourceType, 'session'), eq(schema.chunks.sourceId, sessionId)))
      .run();
  },

  delete(id: string): void {
    this.deleteArchive(id); // must go first: deleting the session loses the id
    db().delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
  },

  /** Set the session-level interview type (chosen by the user at save time). */
  setInterviewType(id: string, interviewType: string): void {
    db()
      .update(schema.sessions)
      .set({ interviewType })
      .where(eq(schema.sessions.id, id))
      .run();
  },

  /** How many questions were detected in a session (for the save prompt). */
  questionCount(id: string): number {
    return (
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.detectedQuestions)
        .where(eq(schema.detectedQuestions.sessionId, id))
        .get()?.c ?? 0
    );
  },

  /** How many transcript turns were captured — the save prompt says so, because
   *  "keep this conversation?" deserves an answer to "was there one?". */
  turnCount(id: string): number {
    return (
      db()
        .select({ c: sql<number>`count(*)` })
        .from(schema.transcriptChunks)
        .where(eq(schema.transcriptChunks.sessionId, id))
        .get()?.c ?? 0
    );
  },

  /** Practice Loop aggregates over every sparring drill's per-answer coaching
   *  (answer_feedback ⨝ sessions kind='sparring'). Small local data — computed
   *  in one pass, no pagination needed. */
  /** Practice trend + per-competency averages. Scoped like `list` — an average
   *  across two people's rehearsals describes neither of them. */
  /**
   * File a finished session into a Space (or out of every Space, with null).
   *
   * "Keep this?" is also "keep it WHERE?" — a call you did not set a Space for
   * often turns out to belong to one, and the Space is what makes the archive
   * and its memories reachable from the next call in that context. Filing has
   * to happen BEFORE the archive is written, since both are scoped from this
   * column.
   */
  setPack(sessionId: string, packId: string | null): void {
    db()
      .update(schema.sessions)
      .set({ packId })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  },

  practiceStats(profileId?: string): PracticeStats {
    const rows = db()
      .select({
        sessionId: schema.answerFeedback.sessionId,
        rating: schema.answerFeedback.rating,
        competency: schema.answerFeedback.competency,
        sessionCreatedAt: schema.sessions.createdAt,
      })
      .from(schema.answerFeedback)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.answerFeedback.sessionId))
      .where(
        profileId
          ? and(eq(schema.sessions.kind, 'sparring'), eq(schema.sessions.profileId, profileId))
          : eq(schema.sessions.kind, 'sparring'),
      )
      .orderBy(asc(schema.sessions.createdAt), asc(schema.answerFeedback.createdAt))
      .all();

    const answers = rows.length;
    const avgRating = answers ? rows.reduce((s, r) => s + r.rating, 0) / answers : 0;

    const byComp = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (!r.competency) continue;
      const c = byComp.get(r.competency) ?? { sum: 0, n: 0 };
      c.sum += r.rating;
      c.n += 1;
      byComp.set(r.competency, c);
    }
    const byCompetency = [...byComp.entries()]
      .map(([competency, { sum, n }]) => ({
        competency: competency as StoryCompetency,
        avgRating: sum / n,
        count: n,
      }))
      .sort((a, b) => b.count - a.count || b.avgRating - a.avgRating);

    // Per-drill averages in chronological order (rows are already sorted).
    const drills = new Map<string, { createdAt: number; sum: number; n: number }>();
    for (const r of rows) {
      const d = drills.get(r.sessionId) ?? { createdAt: r.sessionCreatedAt, sum: 0, n: 0 };
      d.sum += r.rating;
      d.n += 1;
      drills.set(r.sessionId, d);
    }
    const recent = [...drills.entries()]
      .map(([sessionId, d]) => ({
        sessionId,
        createdAt: d.createdAt,
        avgRating: d.sum / d.n,
        answers: d.n,
      }))
      .slice(-12);

    return { sessions: drills.size, answers, avgRating, byCompetency, recent };
  },

  count(): { total: number; live: number } {
    const rows = db().select({ status: schema.sessions.status }).from(schema.sessions).all();
    return { total: rows.length, live: rows.filter((r) => r.status === 'live').length };
  },

  /** Delete every session (and its cascaded transcript/questions/answers/report),
   *  together with every conversation archive — those do not cascade. */
  deleteAll(): void {
    db().delete(schema.chunks).where(eq(schema.chunks.sourceType, 'session')).run();
    db().delete(schema.sessions).run();
  },
};
