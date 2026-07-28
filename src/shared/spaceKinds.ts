import type { ContextPackKind } from './types';

/**
 * What a Space IS, per kind.
 *
 * A Space is "the bundle of context a conversation is grounded in" — that idea
 * was always general, but every field was named for a job interview: *Interview
 * name*, *Client / company*, *Job description*, *Company website*. Someone
 * setting up a Space for their Tuesday standup had to fill in a job
 * description, so `ContextPackKind` existed in the types and meant nothing in
 * the product.
 *
 * The fix is a relabel, not new columns. The underlying shape — a name, a
 * counterparty, one defining document, a link worth reading, free notes — is
 * genuinely universal; only the words were job-specific. So each kind supplies
 * its own vocabulary over the same storage, which keeps every Space in one
 * table, one retrieval path, and one migration-free schema.
 *
 * Column mapping (physical names are v1 legacy and deliberately untouched):
 *   title       → what this Space is called
 *   company     → who it involves
 *   jdText      → the document that defines it
 *   companyUrl  → a page worth reading for background
 *   notes       → anything else, shown in the Cue Card during the session
 */

export interface SpaceKindConfig {
  /** Menu label. */
  label: string;
  /** One line explaining when to pick this kind. */
  hint: string;
  titleLabel: string;
  titlePlaceholder: string;
  partyLabel: string;
  partyPlaceholder: string;
  /** The defining document. */
  docLabel: string;
  docPlaceholder: string;
  /** Some kinds have no meaningful "paste a document" step. */
  docOptional: boolean;
  linkLabel: string;
  linkPlaceholder: string;
  notesLabel: string;
  notesPlaceholder: string;
}

export const SPACE_KINDS: Record<ContextPackKind, SpaceKindConfig> = {
  job: {
    label: 'Job / interview',
    hint: 'A role you are interviewing for.',
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
  meeting: {
    label: 'Meeting / recurring call',
    hint: 'A standup, a client call, a weekly sync — anything that happens again.',
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
    label: 'Project',
    hint: 'An ongoing piece of work you talk about often.',
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
  subject: {
    label: 'Subject / study',
    hint: 'Material you are learning or being tutored on.',
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
    hint: 'Something in your own life you want context kept for.',
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
  custom: {
    label: 'Something else',
    hint: 'Anything that does not fit the others.',
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

export const SPACE_KIND_ORDER: ContextPackKind[] = [
  'meeting',
  'project',
  'job',
  'subject',
  'personal',
  'game',
  'custom',
];

export const spaceKind = (kind: string | null | undefined): SpaceKindConfig =>
  SPACE_KINDS[(kind ?? 'custom') as ContextPackKind] ?? SPACE_KINDS.custom;

/** Structured JD parsing and the pre-interview brief are interview artifacts:
 *  they extract requirements/responsibilities and predict interview questions.
 *  Running them over a standup agenda produces confident nonsense. */
export const isInterviewSpace = (kind: string | null | undefined): boolean => kind === 'job';
