// Domain types shared between main and renderer. No runtime/Node/DOM imports.

export type InterviewType =
  | 'behavioral'
  | 'technical'
  | 'coding'
  | 'system_design'
  | 'product'
  | 'sales'
  | 'general';

/** Answer FORMAT — the single live Cue Card control (v1.2; replaces the old
 *  format/tone × length split). All three read 100% human, never AI-generated.
 *  - `key_points`: short, glanceable — a terse opener + a few key-point bullets.
 *  - `explanation`: a natural, flowing first-person explanation, like talking it
 *    through with someone.
 *  - `detailed`: thorough, with one concrete example. */
export type AnswerFormat = 'key_points' | 'explanation' | 'detailed';

export type DocumentKind = 'resume' | 'jd' | 'note' | 'other';
export type ChunkSource = 'resume' | 'jd' | 'note' | 'company' | 'story';
export type SessionStatus = 'idle' | 'live' | 'stopped';
export type Speaker = 'interviewer' | 'candidate' | 'unknown';

export type QuestionType =
  | 'behavioral'
  | 'resume_project'
  | 'technical_concept'
  | 'coding'
  | 'system_design'
  | 'product'
  | 'followup'
  | 'salary_availability'
  | 'clarification';

export interface Profile {
  id: string;
  name: string;
  targetRole: string;
  targetCompany: string | null;
  interviewType: InterviewType;
  language: string;
  resumeText: string | null;
  jdText: string | null;
  parsedResume: ParsedResume | null;
  parsedJd: ParsedJd | null;
  createdAt: number;
  updatedAt: number;
}

export type ProfileInput = Omit<
  Profile,
  'id' | 'createdAt' | 'updatedAt' | 'parsedResume' | 'parsedJd'
>;

export interface ParsedResume {
  skills: string[];
  projects: { name: string; description: string; impact?: string }[];
  workHistory: { company: string; role: string; period?: string; highlights: string[] }[];
  metrics: string[];
  education: string[];
  certifications: string[];
  techStack: string[];
  leadership: string[];
}

export interface ParsedJd {
  requirements: string[];
  responsibilities: string[];
  keywords: string[];
  focusAreas: string[];
}

/** Structured, interview-relevant research extracted from a company website. */
export interface ParsedCompany {
  overview: string;
  products: string[];
  techStack: string[];
  values: string[];
  culture: string[];
  recentNews: string[];
  interviewAngles: string[]; // ways to tailor answers to this company
}

/** Closed set of behavioral competencies a STAR story can demonstrate. Closed
 *  (not free-form) so tags stay consistent and filterable. Keep in sync with
 *  COMPETENCIES in services/openai/stories.ts. */
export type StoryCompetency =
  | 'leadership'
  | 'teamwork'
  | 'conflict'
  | 'failure'
  | 'ambiguity'
  | 'impact'
  | 'technical_depth'
  | 'communication'
  | 'ownership'
  | 'problem_solving'
  | 'growth'
  | 'customer_focus';

/** A reusable STAR (Situation/Task/Action/Result) story extracted from the
 *  candidate's résumé, tagged by competency + demonstrated skills. Grounded —
 *  never invented. Profile-level and reused across every interview. */
export interface Story {
  id: string;
  profileId: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  competencies: StoryCompetency[];
  skills: string[];
  createdAt: number;
  updatedAt: number;
}

/** A story as produced by the extractor (no identity/timestamps yet). */
export type StoryDraft = Pick<
  Story,
  'title' | 'situation' | 'task' | 'action' | 'result' | 'competencies' | 'skills'
>;

export type StoryInput = Omit<Story, 'id' | 'createdAt' | 'updatedAt'>;

/** Coaching feedback on one spoken answer in a Sparring (two-way voice mock)
 *  round. Grounded in the candidate's actual answer + their résumé/JD — specific
 *  and constructive, never invented. */
export interface SparringFeedback {
  verdict: string; // one-sentence overall take
  rating: number; // 1–5 (how strong the answer was)
  strengths: string[]; // what landed well
  improvements: string[]; // concrete things to do better next time
  tip: string; // one actionable pointer (e.g. a résumé item they could have used)
}

/** A pre-interview prep brief: a résumé × JD × company gap analysis generated
 *  locally-grounded before the call. All fields draw ONLY from the candidate's
 *  parsed résumé, the job's parsed JD, and parsed company research. */
export interface InterviewBrief {
  summary: string; // 1–2 sentence framing of what this interview will probe
  likelyQuestions: { question: string; why: string }[]; // ranked, each tied to a JD/résumé signal
  gaps: { requirement: string; coverage: 'strong' | 'partial' | 'missing'; howToAddress: string }[];
  strengths: { point: string; evidence: string }[]; // résumé highlights that map to the JD
  companyAngles: string[]; // ways to tailor answers to this company
}

export interface Document {
  id: string;
  profileId: string;
  kind: DocumentKind;
  filename: string;
  mime: string | null;
  text: string | null;
  createdAt: number;
}

export interface Note {
  id: string;
  profileId: string;
  content: string;
  createdAt: number;
}

export interface Job {
  id: string;
  profileId: string;
  title: string;
  company: string | null;
  jdUrl: string | null;
  jdText: string | null;
  parsedJd: ParsedJd | null;
  companyUrl: string | null;
  companyResearch: string | null;
  parsedCompany: ParsedCompany | null;
  notes: string | null; // free-form client notes (user-facing, shown in setup + Cue Card)
  createdAt: number;
  updatedAt: number;
}

export interface RetrievedChunk {
  id: string;
  sourceType: ChunkSource;
  content: string;
  score: number;
}

/** Minimum cosine score for a STAR `story` chunk to be surfaced as the live
 *  "Story to tell" cue (and force-included in grounding). Tunable. Shared so the
 *  retriever (inclusion) and the Cue Card (display) agree on the threshold. */
export const STORY_CUE_MIN_SCORE = 0.3;

export interface Session {
  id: string;
  profileId: string;
  jobId: string | null;
  interviewType: InterviewType;
  status: SessionStatus;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

export interface TranscriptChunk {
  id: string;
  sessionId: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  tStart: number | null;
  tEnd: number | null;
  createdAt: number;
}

export interface DetectedQuestion {
  id: string;
  sessionId: string;
  text: string;
  type: QuestionType;
  confidence: number;
  strategy: string;
  createdAt: number;
}

export interface AiAnswer {
  id: string;
  questionId: string;
  directAnswer: string;
  talkingPoints: string[];
  resumeMatch: string | null;
  star: { situation: string; task: string; action: string; result: string } | null;
  clarifyingQuestion: string | null;
  riskWarning: string | null;
  followupQuestion: string | null;
  model: string;
  tokens: { prompt: number; completion: number } | null;
  createdAt: number;
}

export interface SessionReport {
  id: string;
  sessionId: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  perQuestion: { question: string; assessment: string }[];
  createdAt: number;
}

export interface SessionListItem extends Session {
  jobTitle: string | null;
  jobCompany: string | null;
  profileName: string | null;
  typeCounts: Record<string, number>; // detected-question counts by QuestionType
}

export interface SessionDetail extends Session {
  transcript: TranscriptChunk[];
  questions: (DetectedQuestion & { answer: AiAnswer | null })[];
  report: SessionReport | null;
}

export type OverlayMode = 'compact' | 'expanded';

export interface OverlayPrefs {
  opacity: number; // 0..1
  fontSize: number; // px
  mode: OverlayMode;
}

/** Audio capture preferences (configured in the Cue Card settings modal). */
export interface AudioPrefs {
  source: 'system' | 'mic'; // interviewer's system audio vs the microphone
  micDeviceId: string | null; // specific mic input (null = OS default)
}

export interface AppSettings {
  apiKeyPresent: boolean;
  models: Record<string, string>; // user overrides only
  modelPreset: string; // active cost/quality preset: 'balanced' | 'low_cost' | 'best'
  modelDefaults: Record<string, string>; // effective per-task defaults (the active preset's table)
  reasoningEfforts: Record<string, string>; // user reasoning-effort overrides per task
  reasoningEffortDefaults: Record<string, string>; // built-in reasoning effort per task
  overlay: OverlayPrefs;
  audio: AudioPrefs;
  privacyMode: boolean;
  hideTaskbarIcon: boolean; // keep the app off the taskbar (stealth)
  dataConsentAck: boolean;
  tourDone: boolean; // first-run guided tour completed/skipped
  shortcuts: Record<string, string>; // effective global-shortcut accelerators per action
  shortcutDefaults: Record<string, string>; // built-in default accelerator per action
}

// ---- main -> renderer push event payloads ----
export interface TranscriptDeltaEvent {
  text: string;
  isFinal: boolean;
  speaker: Speaker;
}
export interface AnswerDeltaEvent {
  questionId: string;
  token: string;
}
export interface AnswerMetaEvent {
  questionId: string;
  talkingPoints: string[];
  resumeMatch: string | null;
  star: AiAnswer['star'];
  clarifyingQuestion: string | null;
  riskWarning: string | null;
  followupQuestion: string | null;
}
export interface SessionStateEvent {
  status: SessionStatus;
  paused: boolean;
}
export interface ContextSentEvent {
  questionId: string;
  question: string;
  chunks: RetrievedChunk[];
}
