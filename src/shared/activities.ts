import { FLAGS } from './flags';
import type { ContextPackKind, SessionMode } from './types';

/**
 * What you are about to do — the ONE thing the user picks.
 *
 * There used to be two lists. `SessionMode` ("Interview Copilot / Practice /
 * Meeting Copilot / Companion…") was born when the app *was* Interview Copilot,
 * so it is a catalog of product features: one entry isn't a session at all
 * (Practice navigates to a drill page) and two don't exist yet. `ContextPackKind`
 * ("job / meeting / project / subject…") answers what the conversation is about.
 * They collided head-on — `meeting` was in both, `job`↔`interview`,
 * `subject`↔`tutor` — and their defaults contradicted each other: the start
 * modal opened on Interview while a new Space defaulted to Meeting.
 *
 * They collided because they are the same question. So there is one list now,
 * and it is this one. An **activity** is what the call is; the engine mode it
 * runs is derived, never chosen. A mode was never a real choice anyway: what a
 * `ModeDefinition` sets is three dials the start flow already shows on their
 * own — who it listens to, when it speaks, and how it frames you.
 *
 * A Space is a SAVED activity (its `kind` is an activity), so picking a Space
 * answers the question for you. Starting without one is first-class: most calls
 * happen once, and needing to set up a Space first is exactly the friction that
 * made this feel like a job-interview tool.
 *
 * Column mapping for a Space (physical names are v1 legacy, deliberately
 * untouched):
 *   title       → what this Space is called
 *   company     → who it involves
 *   jdText      → the document that defines it
 *   companyUrl  → a page worth reading for background
 *   notes       → anything else, shown in the Cue Card during the session
 */

export interface ActivityConfig {
  /** Menu label — what the user reads when choosing. */
  label: string;
  /** One line explaining when to pick this. */
  hint: string;
  /** What BrainCue actually does here, said plainly. Shown on the choice, so
   *  the behaviour a mode used to advertise is still visible — as a
   *  consequence of the choice rather than a second question. */
  does: string;

  // --- what happens when a session starts ---
  /** The engine mode this runs. Derived from the activity; never picked. */
  mode: SessionMode;
  /** Whose audio, by default. Still overridable at start (an in-person meeting
   *  is a microphone) — this is the sensible default, not a lock. */
  listensTo: 'system' | 'mic';
  /** Whether the profile needs a parsed résumé to start. TRUE for exactly one
   *  activity, which is the point: you should not have to upload a CV to sit in
   *  on your Tuesday standup. */
  needsResume: boolean;

  // --- how a Space of this activity is set up ---
  titleLabel: string;
  titlePlaceholder: string;
  partyLabel: string;
  partyPlaceholder: string;
  /** The defining document. */
  docLabel: string;
  docPlaceholder: string;
  /** Some activities have no meaningful "paste a document" step. */
  docOptional: boolean;
  linkLabel: string;
  linkPlaceholder: string;
  notesLabel: string;
  notesPlaceholder: string;
}

export const ACTIVITIES: Record<ContextPackKind, ActivityConfig> = {
  meeting: {
    label: 'Meeting or call',
    hint: 'A standup, a client call, a weekly sync — anything with other people in it.',
    does: 'Sits in quietly. Surfaces context, open questions, action items, and decisions.',
    mode: 'meeting',
    listensTo: 'system',
    needsResume: false,
    titleLabel: 'Meeting name',
    titlePlaceholder: 'e.g. Tuesday standup — Atlas',
    partyLabel: 'With (team, client, or org)',
    partyPlaceholder: 'e.g. Acme — platform team',
    docLabel: 'Agenda, charter, or brief',
    docPlaceholder: 'What this meeting is for, who attends, what gets decided in it',
    docOptional: true,
    linkLabel: 'Related link',
    linkPlaceholder: 'https://…  (docs, wiki, account page)',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. Priya runs it. Keep updates under a minute. Never commit to dates here.',
  },
  project: {
    label: 'Project discussion',
    hint: 'A conversation about a piece of work you talk about often.',
    does: 'Sits in quietly. Surfaces what was decided before, open threads, and new action items.',
    mode: 'meeting',
    listensTo: 'system',
    needsResume: false,
    titleLabel: 'Project name',
    titlePlaceholder: 'e.g. Atlas migration',
    partyLabel: 'Team or client',
    partyPlaceholder: 'e.g. Platform team',
    docLabel: 'Project brief',
    docPlaceholder: 'Goals, scope, current state, the decisions already made',
    docOptional: true,
    linkLabel: 'Project link',
    linkPlaceholder: 'https://…  (repo, board, spec)',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. Phase 2 starts in September. Budget is fixed.',
  },
  job: {
    label: 'Interview',
    hint: 'You are the candidate and someone is assessing you.',
    does: 'Hears each question and streams a grounded answer cue — framed as you, drawing on your résumé and stories.',
    mode: 'interview',
    listensTo: 'system',
    needsResume: true,
    titleLabel: 'Interview name / role',
    titlePlaceholder: 'e.g. Acme — Senior PM',
    partyLabel: 'Client / company',
    partyPlaceholder: 'e.g. Acme',
    docLabel: 'Job description',
    docPlaceholder: 'Paste the job description',
    docOptional: false,
    linkLabel: 'Company website',
    linkPlaceholder: 'https://company.com',
    notesLabel: 'Notes about this client',
    notesPlaceholder: 'e.g. Recruiter: Jane. Panel of 3. They care about system design. Remote.',
  },
  subject: {
    label: 'Study or tutoring',
    hint: 'Material you are learning or being taught.',
    does: 'Sits in quietly and pulls up the parts of your material that bear on what was just said.',
    mode: 'meeting',
    listensTo: 'system',
    needsResume: false,
    titleLabel: 'Subject',
    titlePlaceholder: 'e.g. Distributed systems',
    partyLabel: 'Course or source',
    partyPlaceholder: 'e.g. MIT 6.824',
    docLabel: 'Syllabus or material',
    docPlaceholder: 'Paste the syllabus, notes, or the material you are working through',
    docOptional: true,
    linkLabel: 'Reference link',
    linkPlaceholder: 'https://…  (course page, textbook)',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. Exam in November. Weakest on consensus.',
  },
  personal: {
    label: 'Personal',
    hint: 'Something in your own life — a landlord, a doctor, a bank.',
    does: 'Sits in quietly. Keeps the background straight and catches what you agreed to.',
    mode: 'meeting',
    listensTo: 'system',
    needsResume: false,
    titleLabel: 'What is this about?',
    titlePlaceholder: 'e.g. House move',
    partyLabel: 'Who is involved',
    partyPlaceholder: 'e.g. Sam, the agent',
    docLabel: 'Background',
    docPlaceholder: 'Anything worth knowing before a conversation about this',
    docOptional: true,
    linkLabel: 'Link',
    linkPlaceholder: 'https://…',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. Completion is 12 September.',
  },
  game: {
    label: 'Game',
    hint: 'A game you want a companion alongside.',
    does: 'Listens to you and stays out of the way — flags what you said you would do, remembers what you saved.',
    mode: 'companion',
    listensTo: 'mic',
    needsResume: false,
    titleLabel: 'Game',
    titlePlaceholder: 'e.g. Baldur’s Gate 3',
    partyLabel: 'Server or group',
    partyPlaceholder: 'e.g. Thursday co-op group',
    docLabel: 'Notes on the game',
    docPlaceholder: 'Build, party, current quest — whatever you want it to know',
    docOptional: true,
    linkLabel: 'Wiki or guide',
    linkPlaceholder: 'https://…',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. No spoilers past act 2.',
  },
  solo: {
    label: 'Just me',
    hint: 'No call — thinking out loud while you work.',
    does: 'Listens to you and stays out of the way — flags tasks, offers context, surfaces what you saved.',
    mode: 'companion',
    listensTo: 'mic',
    needsResume: false,
    titleLabel: 'What are you working on?',
    titlePlaceholder: 'e.g. Deep work — the rewrite',
    partyLabel: 'Related to',
    partyPlaceholder: 'A project, a team, or nothing at all',
    docLabel: 'Background',
    docPlaceholder: 'What you are working on, so it can follow along',
    docOptional: true,
    linkLabel: 'Link',
    linkPlaceholder: 'https://…',
    notesLabel: 'Notes',
    notesPlaceholder: 'e.g. Don’t interrupt before 11. Nudge me about the changelog.',
  },
  custom: {
    label: 'Something else',
    hint: 'Anything that does not fit the others.',
    does: 'Sits in quietly and contributes only when it is confident.',
    mode: 'meeting',
    listensTo: 'system',
    needsResume: false,
    titleLabel: 'Name',
    titlePlaceholder: 'What is this Space called?',
    partyLabel: 'Related to',
    partyPlaceholder: 'A person, team, or organisation',
    docLabel: 'Background',
    docPlaceholder: 'The context a conversation here should be grounded in',
    docOptional: true,
    linkLabel: 'Link',
    linkPlaceholder: 'https://…',
    notesLabel: 'Notes',
    notesPlaceholder: 'Anything else worth having on hand',
  },
};

/** Menu order: the conversations someone has every day come first. Interview is
 *  still fully shipped — it just no longer defines the product. */
export const ACTIVITY_ORDER: ContextPackKind[] = [
  'meeting',
  'project',
  'job',
  'subject',
  'personal',
  'game',
  'solo',
  'custom',
];

/** The default for a new Space and a new session: the daily case. */
export const DEFAULT_ACTIVITY: ContextPackKind = 'meeting';

/** An unknown or absent kind falls back to `custom` rather than throwing, so v1
 *  rows and hand-edited databases keep working. Deliberately NOT
 *  `DEFAULT_ACTIVITY`: not knowing what something is should read as "something
 *  else", not as a confident claim that it was a meeting. */
export const activity = (kind: string | null | undefined): ActivityConfig =>
  ACTIVITIES[kind as ContextPackKind] ?? ACTIVITIES.custom;

/** Is this engine mode built and switched on? Modes are gated in flags.ts; an
 *  activity whose mode is off is not offered rather than silently downgraded
 *  into a different one — starting a standup as an interview is worse than not
 *  starting it. */
export const modeEnabled = (mode: SessionMode): boolean => {
  if (mode === 'meeting') return FLAGS.meeting;
  if (mode === 'companion') return FLAGS.companion;
  if (mode === 'tutor') return FLAGS.tutor;
  if (mode === 'interviewer_assist') return FLAGS.interviewerAssist;
  return true; // interview + practice have always shipped
};

/** Which engine mode an activity runs. The single mapping, used by the start
 *  flow AND the engine, so what the user was shown and what actually runs can
 *  never drift apart. */
export const modeFor = (kind: string | null | undefined): SessionMode => activity(kind).mode;

/** The activities that can be started right now. */
export const startableActivities = (): ContextPackKind[] =>
  ACTIVITY_ORDER.filter((k) => modeEnabled(ACTIVITIES[k].mode));

/** Structured JD parsing and the pre-interview brief are interview artifacts:
 *  they extract requirements/responsibilities and predict interview questions.
 *  Running them over a standup agenda produces confident nonsense. */
export const isInterviewSpace = (kind: string | null | undefined): boolean => kind === 'job';
