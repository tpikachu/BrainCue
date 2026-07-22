import { sql } from 'drizzle-orm';
import { blob, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  targetRole: text('target_role').notNull().default(''),
  targetCompany: text('target_company'),
  interviewType: text('interview_type').notNull().default('general'),
  language: text('language').notNull().default('en'),
  resumeText: text('resume_text'),
  jdText: text('jd_text'),
  parsedResume: text('parsed_resume'), // json
  parsedJd: text('parsed_jd'), // json
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime'),
    sourcePath: text('source_path'),
    text: text('text'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('documents_profile_idx').on(t.profileId) }),
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('notes_profile_idx').on(t.profileId) }),
);

// A Context Pack ("Space" in the UI) — the bundle of documents a session is
// grounded in. v1's "jobs" generalized: a pack of kind 'job' is exactly the old
// job (JD + company research); other kinds arrive with their modes (tutor's
// 'subject', meeting packs, …). PHYSICAL table/column names stay 'jobs'/'job_id'
// — the rename is logical (TS + APIs) so no table rebuild is needed; see
// docs/12-ENGINE-PLAN.md.
export const contextPacks = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('job'), // ContextPackKind
    title: text('title').notNull().default(''),
    company: text('company'),
    jdUrl: text('jd_url'), // optional link to the original posting (reference only)
    jdText: text('jd_text'),
    parsedJd: text('parsed_jd'), // json
    companyUrl: text('company_url'), // optional company website to research
    companyResearch: text('company_research'), // raw text scraped from the site
    parsedCompany: text('parsed_company'), // json — structured interview-relevant research
    notes: text('notes'), // free-form client notes (shown when selecting + in the Cue Card)
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('jobs_profile_idx').on(t.profileId) }),
);

/** @deprecated v1 name — use {@link contextPacks}. */
export const jobs = contextPacks;

// Reusable STAR stories extracted from the candidate's résumé, tagged by
// competency + demonstrated skills. Profile-level (reused across all interviews);
// also indexed as `story` chunks so they can ground live answers.
export const stories = sqliteTable(
  'stories',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    situation: text('situation').notNull().default(''),
    task: text('task').notNull().default(''),
    action: text('action').notNull().default(''),
    result: text('result').notNull().default(''),
    competencies: text('competencies'), // json[] — closed competency set
    skills: text('skills'), // json[]
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('stories_profile_idx').on(t.profileId) }),
);

// A job application from the Tailor Resume flow. Owns a dedicated jobs row (the JD +
// the tailored resume's `tailored` chunks); "Start interview" launches a session with
// (profile_id, job_id) so grounding swaps to the tailored resume automatically.
export const applications = sqliteTable(
  'applications',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    packId: text('job_id')
      .notNull()
      .references(() => contextPacks.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''), // candidate/application name
    jobTitle: text('job_title').notNull().default(''), // extracted from the JD
    company: text('company'), // extracted from the JD
    baseResume: text('base_resume').notNull(), // input snapshot (provenance)
    tailoredResume: text('tailored_resume').notNull(), // markdown — PDF + chunk source
    answers: text('answers'), // json[] — [{ question, answer }]
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    byProfile: index('applications_profile_idx').on(t.profileId),
    byCreated: index('applications_created_idx').on(t.createdAt),
  }),
);

export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // Resume/notes/story chunks have packId null; JD/company/tailored chunks
    // belong to a specific context pack (physical column name is legacy 'job_id').
    packId: text('job_id').references(() => contextPacks.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(), // resume | jd | note | company | story | tailored
    sourceId: text('source_id'),
    ord: integer('ord').notNull().default(0),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('chunks_profile_idx').on(t.profileId) }),
);

export const embeddings = sqliteTable(
  'embeddings',
  {
    id: text('id').primaryKey(),
    chunkId: text('chunk_id')
      .notNull()
      .unique()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dim: integer('dim').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(), // Float32Array bytes
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byChunk: index('embeddings_chunk_idx').on(t.chunkId) }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    packId: text('job_id').references(() => contextPacks.id, { onDelete: 'set null' }),
    // The MODE this session ran in (v2): interview | practice | … (SessionMode).
    // Migration 0008 backfills live→interview, mock/sparring→practice.
    mode: text('mode').notNull().default('interview'),
    // What produced this session: a real interview ('live'), a mock rehearsal
    // ('mock' — deleted at stop, only ever transient), or a Sparring practice
    // drill ('sparring' — persisted so coaching scores accumulate in Reports).
    // @deprecated superseded by `mode`; kept for v1 compatibility.
    kind: text('kind').notNull().default('live'),
    interviewType: text('interview_type').notNull().default('general'),
    status: text('status').notNull().default('idle'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byProfile: index('sessions_profile_idx').on(t.profileId) }),
);

export const transcriptChunks = sqliteTable(
  'transcript_chunks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    speaker: text('speaker').notNull().default('unknown'),
    text: text('text').notNull(),
    isFinal: integer('is_final').notNull().default(0),
    tStart: integer('t_start'),
    tEnd: integer('t_end'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ bySession: index('transcript_session_idx').on(t.sessionId) }),
);

export const detectedQuestions = sqliteTable(
  'detected_questions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    type: text('type').notNull().default('behavioral'),
    confidence: real('confidence').notNull().default(0),
    strategy: text('strategy').notNull().default(''),
    transcriptChunkId: text('transcript_chunk_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ bySession: index('questions_session_idx').on(t.sessionId) }),
);

export const aiAnswers = sqliteTable(
  'ai_answers',
  {
    id: text('id').primaryKey(),
    questionId: text('question_id')
      .notNull()
      .references(() => detectedQuestions.id, { onDelete: 'cascade' }),
    directAnswer: text('direct_answer').notNull().default(''),
    // (v1.5) The dead expanded-meta columns (talking_points / resume_match / star /
    // clarifying_question) were dropped — the UI for them was removed in v1.0 and
    // they were always empty. riskWarning still flows; followupQuestion is now the
    // post-stream follow-up PREDICTION shown under the Cue Card answer.
    riskWarning: text('risk_warning'),
    followupQuestion: text('followup_question'),
    model: text('model').notNull().default(''),
    tokens: text('tokens'), // json
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byQuestion: index('answers_question_idx').on(t.questionId) }),
);

// Per-answer coaching from a Sparring drill (the Practice Loop): every spoken
// answer's rating + feedback persists here as it happens, so practice compounds
// into trends instead of evaporating when the round ends. One row per answered
// question; the session's report is assembled from these at end().
export const answerFeedback = sqliteTable(
  'answer_feedback',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => detectedQuestions.id, { onDelete: 'cascade' }),
    answerTranscript: text('answer_transcript').notNull().default(''),
    rating: integer('rating').notNull().default(0), // 1–5
    verdict: text('verdict').notNull().default(''),
    strengths: text('strengths'), // json[]
    improvements: text('improvements'), // json[]
    tip: text('tip'),
    competency: text('competency'), // StoryCompetency | null — powers practice trends
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ bySession: index('answer_feedback_session_idx').on(t.sessionId) }),
);

export const sessionReports = sqliteTable('session_reports', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull().default(''),
  strengths: text('strengths'), // json[]
  improvements: text('improvements'), // json[]
  perQuestion: text('per_question'), // json[]
  createdAt: integer('created_at').notNull().default(now),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
