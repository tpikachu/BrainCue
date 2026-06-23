// Domain types shared between main and renderer. No runtime/Node/DOM imports.

export type InterviewType =
  | 'behavioral'
  | 'technical'
  | 'coding'
  | 'system_design'
  | 'product'
  | 'sales'
  | 'general';

export type AnswerStyle =
  | 'concise'
  | 'detailed'
  | 'star'
  | 'technical'
  | 'conversational';

export type DocumentKind = 'resume' | 'jd' | 'note' | 'other';
export type ChunkSource = 'resume' | 'jd' | 'note' | 'company';
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
  answerStyle: AnswerStyle;
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
  createdAt: number;
  updatedAt: number;
}

export interface RetrievedChunk {
  id: string;
  sourceType: ChunkSource;
  content: string;
  score: number;
}

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

export interface AppSettings {
  apiKeyPresent: boolean;
  models: Record<string, string>; // user overrides only
  modelDefaults: Record<string, string>; // built-in defaults per purpose
  overlay: OverlayPrefs;
  privacyMode: boolean;
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
