import { sql } from 'drizzle-orm';
import { blob, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  targetRole: text('target_role').notNull().default(''),
  targetCompany: text('target_company'),
  interviewType: text('interview_type').notNull().default('general'),
  answerStyle: text('answer_style').notNull().default('concise'),
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

// A profile (the candidate/resume) can target multiple jobs; each job holds its
// own job description + parsed JSON and is added/parsed independently.
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
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
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
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
    // Resume/notes/story chunks have jobId null; JD/company/tailored chunks belong
    // to a specific job.
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
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
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
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
    talkingPoints: text('talking_points'), // json[]
    resumeMatch: text('resume_match'),
    star: text('star'), // json
    clarifyingQuestion: text('clarifying_question'),
    riskWarning: text('risk_warning'),
    followupQuestion: text('followup_question'),
    model: text('model').notNull().default(''),
    tokens: text('tokens'), // json
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ byQuestion: index('answers_question_idx').on(t.questionId) }),
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
