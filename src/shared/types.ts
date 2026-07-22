// Domain types shared between main and renderer. No runtime/Node/DOM imports.

// SWE-focused (product/sales sessions removed — BrainCue targets software engineers).
// Old DB rows with a removed type still load (stored as text); they just can't be
// re-selected.
export type InterviewType =
  | 'behavioral'
  | 'technical'
  | 'coding'
  | 'system_design'
  | 'general';

/** Answer FORMAT — the single live Cue Card control (v1.2; replaces the old
 *  format/tone × length split). All read 100% human, never AI-generated.
 *  - `key_points`: short, glanceable — a terse opener + a few key-point bullets.
 *  - `explanation`: a natural, flowing first-person explanation, like talking it
 *    through with someone.
 *  - `detailed`: thorough, with one concrete example.
 *  - `story_teller`: a short, vivid first-person story (hook → challenge → what I
 *    did → outcome) — memorable, great for behavioral answers. */
export type AnswerFormat = 'key_points' | 'explanation' | 'detailed' | 'story_teller';

export type DocumentKind = 'resume' | 'jd' | 'note' | 'other';
/** `tailored` = an application's tailored resume, indexed pack-scoped; when a pack
 *  has tailored chunks, retrieval drops the base `resume` chunks for its sessions. */
export type ChunkSource = 'resume' | 'jd' | 'note' | 'company' | 'story' | 'tailored';
export type SessionStatus = 'idle' | 'live' | 'stopped';

// ---- v2 domain vocabulary (see docs/12-ENGINE-PLAN.md) ----

/** The mode a session runs in. v1 rows are backfilled by migration 0008
 *  (kind live→interview, mock/sparring→practice); the other modes arrive with
 *  the engine phases. */
export type SessionMode =
  | 'interview'
  | 'practice'
  | 'interviewer_assist'
  | 'meeting'
  | 'tutor'
  | 'companion';

/** What a Context Pack ("Space" in the UI) is about. v1 jobs are packs of
 *  kind 'job'; other kinds arrive with their modes. */
export type ContextPackKind =
  | 'job'
  | 'subject'
  | 'project'
  | 'meeting'
  | 'personal'
  | 'game'
  | 'custom';

/** Every engine output is a Contribution of one of these kinds (the overlay
 *  renders each kind as its own card type from the contribution-cards PR on). */
export type ContributionKind =
  | 'answer'
  | 'code'
  | 'context'
  | 'action_item'
  | 'open_question'
  | 'suggested_question'
  | 'coverage'
  | 'warning'
  | 'decision'
  | 'tutor_prompt'
  | 'memory_suggestion'
  | 'summary';

/** How present the companion is in an ambient session (Meeting, later
 *  Companion). Levels map to EXPLICIT thresholds/cooldowns in the engine
 *  (trigger/presence.ts) — never a vague slider feeding a prompt. */
export type Presence = 'summoned' | 'quiet' | 'balanced' | 'active';

// --- Local memory (v2 Prompt 8) ---------------------------------------------
// Memory belongs to the user: candidates are extracted conservatively AFTER
// consent, reviewed explicitly, and only approved items ever ground answers.

export type MemoryCategory =
  | 'preference'
  | 'person'
  | 'project'
  | 'goal'
  | 'decision'
  | 'fact'
  | 'workflow'
  | 'custom';

/** One lifecycle: pending = MemoryCandidate (awaiting review), approved =
 *  durable MemoryItem, rejected/archived = out of retrieval. */
export type MemoryStatus = 'pending' | 'approved' | 'rejected' | 'archived';

export interface MemoryItem {
  id: string;
  profileId: string;
  /** null = global to the profile; set = scoped to one Space. */
  packId: string | null;
  category: MemoryCategory;
  content: string;
  /** Provenance: the session/contribution/transcript ids this came from. */
  sourceRefs: { type: string; id: string }[] | null;
  confidence: number;
  importance: number;
  sensitive: boolean;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

/** A memory recalled for grounding — cited separately from documents ([M1]…). */
export interface RetrievedMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  score: number;
}

/** Stable lifecycle every Contribution moves through. */
export type ContributionStatus =
  | 'planned'
  | 'streaming'
  | 'completed'
  | 'dismissed'
  | 'accepted'
  | 'corrected'
  | 'failed';

/** Generic engine output (v2 domain model). Persistence lands with the engine
 *  extraction; this PR establishes the shared shape. */
export interface Contribution {
  id: string;
  sessionId: string;
  kind: ContributionKind;
  status: ContributionStatus;
  title: string | null;
  body: string;
  meta: Record<string, unknown> | null;
  /** Provenance: transcript turn / chunk / memory ids this contribution drew on. */
  sourceRefs: { type: string; id: string }[] | null;
  createdAt: number;
  updatedAt: number;
}

/** v2 speaker vocabulary. The legacy literals stay in the union so v1 rows and
 *  the current write path keep typechecking unchanged; `normalizeSpeaker` maps
 *  them (the engine adopts the new vocabulary in the extraction PR — no rows
 *  are rewritten). */
export type LegacySpeaker = 'interviewer' | 'candidate';
export type Speaker = 'you' | 'them' | 'agent' | 'unknown' | LegacySpeaker;

export function normalizeSpeaker(s: string): 'you' | 'them' | 'agent' | 'unknown' {
  if (s === 'candidate' || s === 'you') return 'you';
  if (s === 'interviewer' || s === 'them') return 'them';
  if (s === 'agent') return 'agent';
  return 'unknown';
}

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
  /** The one competency the question probed (closed StoryCompetency set) — powers
   *  the per-competency practice trends in Reports. Null if unclassifiable. */
  competency: StoryCompetency | null;
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

/** A Context Pack ("Space" in the UI): the document bundle a session grounds
 *  in. v1's Job generalized — a pack of kind 'job' carries the JD/company
 *  fields exactly as before; other kinds arrive with their modes. */
export interface ContextPack {
  id: string;
  profileId: string;
  kind: ContextPackKind;
  title: string;
  company: string | null;
  jdUrl: string | null;
  jdText: string | null;
  parsedJd: ParsedJd | null;
  companyUrl: string | null;
  companyResearch: string | null;
  parsedCompany: ParsedCompany | null;
  notes: string | null; // free-form client notes (user-facing, shown in setup + Cue Card)
  /** Per-Space memory opt-out (matters only while global memory consent is on). */
  memoryEnabled: boolean;
  /** Per-Space companion behavior overrides (null = inherit global config). */
  companionPrefs: CompanionSpaceOverrides | null;
  createdAt: number;
  updatedAt: number;
}

/** @deprecated v1 name for a ContextPack (kind 'job'). */
export type Job = ContextPack;

/** One application question + its grounded answer (Tailor Resume flow). */
export interface ApplicationAnswer {
  question: string;
  answer: string;
}

/** A job application produced by the Tailor Resume flow: an ATS-friendly resume
 *  tailored from a base resume × a JD (grounded — no invented experience), plus
 *  answers to the application's questions. Owns a dedicated Job row holding the JD;
 *  the tailored resume is indexed as that job's `tailored` chunks, so "Start
 *  interview" grounds the live session in the TAILORED resume + JD. */
export interface Application {
  id: string;
  profileId: string; // owning (real) profile — sessions/stories still belong to it
  jobId: string; // dedicated job row (JD + tailored chunks); hidden from the Interviews table
  name: string; // candidate/application name — shown as "[name] - [jobTitle] at [company]"
  jobTitle: string;
  company: string | null;
  baseResume: string; // input snapshot (provenance)
  tailoredResume: string; // markdown — the PDF source + `tailored` chunk source
  answers: ApplicationAnswer[];
  createdAt: number;
  updatedAt: number;
}

export interface ApplicationListItem extends Application {
  profileName: string | null;
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

/** What produced a session: a real interview, a mock rehearsal (transient — the
 *  row is deleted at stop), or a Sparring practice drill (persisted coaching). */
export type SessionKind = 'live' | 'mock' | 'sparring';

export interface Session {
  id: string;
  profileId: string;
  jobId: string | null; // context-pack id (field name kept for IPC compatibility)
  mode: SessionMode;
  /** @deprecated superseded by `mode`; kept for v1 compatibility. */
  kind: SessionKind;
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
  riskWarning: string | null;
  /** Predicted likely interviewer follow-up (v1.5) — generated post-stream. */
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

/** End-of-meeting report (Meeting Copilot). Owners/deadlines are null unless
 *  EXPLICIT in the transcript — the generator post-filters anything the model
 *  invents (see engine/meetingReport.ts). Persisted as a `summary`
 *  contribution whose meta carries this structure. */
export interface MeetingActionItem {
  text: string;
  owner: string | null;
  deadline: string | null;
}
export interface MeetingDecision {
  text: string;
  owner: string | null;
}
export interface MeetingReport {
  summary: string;
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  openQuestions: string[];
}

/** Aggregated Practice Loop stats across all sparring drills (Reports). */
export interface PracticeStats {
  sessions: number; // sparring drills with at least one coached answer
  answers: number; // total coached answers
  avgRating: number; // mean rating across all answers (0 when none)
  byCompetency: { competency: StoryCompetency; avgRating: number; count: number }[]; // count desc
  /** Per-drill average rating, oldest → newest (trend line; last 12 drills). */
  recent: { sessionId: string; createdAt: number; avgRating: number; answers: number }[];
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
  codingLanguage: string; // language the coding solver writes solutions in (default 'javascript')
  privacyMode: boolean;
  hideTaskbarIcon: boolean; // keep the app off the taskbar (stealth)
  dataConsentAck: boolean;
  /** Global memory consent — OFF by default: no extraction, no recall until
   *  the user explicitly enables it (Library › Memory). */
  memoryEnabled: boolean;
  /** Global companion configuration (personality, default presence, DND,
   *  default budget). */
  companionPrefs: CompanionPrefs;
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
  riskWarning: string | null;
}
/** Post-stream follow-up prediction for a just-answered question (v1.5). */
export interface AnswerFollowupEvent {
  questionId: string;
  followup: string;
}
export interface SessionStateEvent {
  status: SessionStatus;
  paused: boolean;
}
export interface ContextSentEvent {
  questionId: string;
  question: string;
  chunks: RetrievedChunk[];
  /** Memories that grounded this answer (cited as [M1]… — separate from
   *  documents). Present only when memory recall returned something. */
  memories?: RetrievedMemory[];
}

// --- Generic contribution events (EVENTS.contribution*) ---------------------
// The overlay's v2 card feed. Main dual-emits these alongside the legacy
// answer* events above, which stay as a one-release compatibility adapter
// (the dashboard still consumes them) — see src/main/ipc/contributionBridge.ts.

/** A new contribution began (a detected question's answer, a coding solve, …). */
export interface ContributionOpenEvent {
  contributionId: string;
  kind: ContributionKind;
  title: string;
}
/** One streamed token of the contribution body. */
export interface ContributionDeltaEvent {
  contributionId: string;
  token: string;
}
/** Named post-open annotations. Exactly the payloads the legacy answer events
 *  carried, so cards render identically; only the fields present are patched. */
export interface ContributionPatchEvent {
  contributionId: string;
  /** The legacy answerMeta payload — ambient cards ride kind-specific
   *  annotations (e.g. a memory card's memoryId/why) on it as extra fields,
   *  with riskWarning null. */
  meta?: AnswerMetaEvent & Record<string, unknown>;
  context?: ContextSentEvent;
  followup?: string;
}
/** The contribution's stream finished (completed OR aborted — mirrors answerDone). */
export interface ContributionDoneEvent {
  contributionId: string;
}
/** The contribution is being re-generated: clear its body, keep the card. */
export interface ContributionResetEvent {
  contributionId: string;
}

// --- Voice / summon layer (v2, Prompt 9) ------------------------------------
// Voice is an OUTPUT SURFACE over the generic contribution pipeline, not a
// mode: a summon transcribes the user's speech, routes it as a direct ask
// (live session) or a quick ask (default Space), and the reply streams to the
// Cue Card as text while sentence-chunked TTS plays it aloud. Only summoned
// replies are ever spoken — ambient cards never trigger speech.

/** Dialogue controller states (explicit, main-owned; see
 *  services/voice/dialogueController.ts for the transition table). */
export type VoiceState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'paused'
  | 'error';

/** Pushed on EVENTS.voiceState whenever the dialogue controller transitions.
 *  `generation` invalidates everything from earlier turns: the renderer drops
 *  queued audio whose generation no longer matches (stale-audio cancellation). */
export interface VoiceStateEvent {
  state: VoiceState;
  generation: number;
  /** What the STT heard (set once transcription completes, from `thinking` on). */
  transcript?: string;
  /** The contribution being spoken (set from `speaking` on). */
  contributionId?: string;
  /** Speech synthesis was unavailable/muted — the reply is text-only. */
  textOnly?: boolean;
  error?: string;
}

/** One synthesized speech segment (a sentence), pushed on EVENTS.voiceAudio.
 *  Segments play strictly in `seq` order; `last` marks the reply's final one. */
export interface VoiceAudioEvent {
  generation: number;
  seq: number;
  audioBase64: string;
  mime: string;
  last: boolean;
}

// --- Companion (v2, Prompt 10) ----------------------------------------------
// Companion is an EXPLICITLY started session (no background listening before
// consent). Its posture is a CompanionPresence — richer than the engine's
// Presence dial because "off" (hard mute) and "on demand" (summon-only) are
// distinct user promises. The InterjectionPolicy engine maps these to
// explicit deterministic gates; the LLM only ever scores salience.

export type CompanionPresence = 'off' | 'on_demand' | 'assistive' | 'proactive';

/** Coarse projection of the companion posture onto the engine's Presence dial
 *  (session:start speaks Presence). Off and on-demand both disable ambient at
 *  the engine level; the InterjectionPolicy separately treats off as the hard
 *  mute. Shared so the start flow and the engine agree by construction. */
export const COMPANION_TO_ENGINE_PRESENCE: Record<CompanionPresence, Presence> = {
  off: 'summoned',
  on_demand: 'summoned',
  assistive: 'balanced',
  proactive: 'active',
};

/** Global companion personality (settings key `companion_prefs`). ONE source
 *  of truth rendered by `engine/persona.ts` — never duplicated per mode. */
export interface CompanionPersonality {
  /** What the companion calls itself. */
  name: string;
  /** TTS voice override for companion sessions (null = voice-layer default). */
  voice: string | null;
  tone: 'warm' | 'neutral' | 'direct';
  brevity: 'terse' | 'normal' | 'chatty';
  humor: boolean;
}

/** A do-not-disturb window in minutes-of-day (local). start > end spans
 *  midnight (e.g. 1320–420 = 22:00–07:00). */
export interface DndWindow {
  startMin: number;
  endMin: number;
}

export interface CompanionPrefs {
  personality: CompanionPersonality;
  /** Default posture for new companion sessions. */
  presence: CompanionPresence;
  dnd: DndWindow[];
  /** Default hard session budget in cents (null = no cap). */
  budgetCents: number | null;
}

/** Per-Space behavior overrides (jobs.companion_prefs json) — every field
 *  optional; absent = inherit the global config. */
export interface CompanionSpaceOverrides {
  tone?: CompanionPersonality['tone'];
  brevity?: CompanionPersonality['brevity'];
  humor?: boolean;
  presence?: CompanionPresence;
}

/** Cost-governance snapshot: model calls + token usage where reported, and a
 *  deterministic cents ESTIMATE (documented flat rates — visibility, not
 *  billing). */
export interface CompanionCost {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estCents: number;
  budgetCents: number | null;
  /** Crossed the warning threshold (once). */
  warned: boolean;
  /** Hard budget reached — automatic contributions stop. */
  exhausted: boolean;
}

/** Pushed on EVENTS.companionStatus while a companion session runs. */
export interface CompanionStatusEvent {
  sessionId: string;
  presence: CompanionPresence;
  cost: CompanionCost;
}

/** Voice preferences (settings key `voice_prefs`). */
export interface VoicePrefs {
  /** TTS voice id (provider-interpreted; OpenAI: alloy/echo/fable/…). */
  voice: string;
  /** Hard mute: no speech output at all (replies stay text-only). */
  muted: boolean;
  /** Preferred audio output device (renderer setSinkId), null = system default. */
  outputDeviceId: string | null;
  /** Persist no-session quick asks (as contributions in a per-profile
   *  'companion' session). OFF by default — ephemeral unless opted in. */
  saveQuickAsks: boolean;
  /** Default Space grounding no-session quick asks (null = profile only). */
  quickAskPackId: string | null;
}
