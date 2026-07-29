import type { ContextPackKind } from './types';

/**
 * What an archive of a conversation records — one fixed format per activity.
 *
 * A Space accumulates. Its documents are the knowledge base it starts from, and
 * every session kept in it adds an archive, so the tenth standup is grounded in
 * the previous nine. That only works if the archives are *comparable*: a
 * retrieval hit is useful when "Decided:" means the same thing in every entry
 * for that Space, and useless when each entry is shaped however the summariser
 * felt that day.
 *
 * So the format is standardized — and standardized PER ACTIVITY, because the
 * things worth carrying forward genuinely differ. A standup's residue is
 * decisions, commitments, and blockers. An interview's is which questions were
 * asked and what you claimed, where "action items" is a category that barely
 * occurs. A study session's is what was covered and what did not land.
 * Forcing one shape on all of them either invents decisions in a tutorial or
 * throws away the questions from an interview.
 *
 * Four things are universal and live outside this table, because every
 * conversation has them: the topic, the summary, who it was about, and the
 * verbatim quotes (docs/16-CONTINUITY.md §10).
 */
export interface ArchiveSection {
  /** JSON key the summariser returns, and the stable identity of the section. */
  key: string;
  /** Heading in the archive text — what a reader sees weeks later. */
  label: string;
  /** The one line that tells the summariser what belongs here. */
  guidance: string;
  /** Cap. A section that can hold twenty items is a transcript, not an archive. */
  max: number;
}

const DECISIONS: ArchiveSection = {
  key: 'decisions',
  label: 'Decided',
  guidance: 'things that were SETTLED, not things that were merely discussed',
  max: 8,
};
const ACTIONS: ArchiveSection = {
  key: 'actionItems',
  label: 'Action items',
  guidance:
    'commitments someone made — lead with the owner when the transcript names one ("Sarah Chen — send the revised quote by Friday")',
  max: 10,
};
const OPEN: ArchiveSection = {
  key: 'openQuestions',
  label: 'Still open',
  guidance: 'things raised and left unresolved',
  max: 6,
};

/** The shape that fits any conversation between people about work. */
const CONVERSATION: ArchiveSection[] = [DECISIONS, ACTIONS, OPEN];

export const ARCHIVE_FORMATS: Record<ContextPackKind, ArchiveSection[]> = {
  meeting: CONVERSATION,
  project: [
    DECISIONS,
    ACTIONS,
    OPEN,
    {
      key: 'changes',
      label: 'Changed since last time',
      guidance:
        'anything that moved — scope, dates, owners, status — stated as the change, not the current value ("the launch slipped from September to November")',
      max: 6,
    },
  ],
  job: [
    {
      key: 'questionsAsked',
      label: 'They asked',
      guidance:
        'the questions the interviewer actually asked, in their own framing, so a later interview can tell what this company probes for',
      max: 10,
    },
    {
      key: 'claims',
      label: 'You said',
      guidance:
        'the substantive claims the candidate made about their experience — later conversations must stay consistent with these',
      max: 8,
    },
    {
      key: 'theyEmphasised',
      label: 'They emphasised',
      guidance:
        'what the interviewer kept returning to, or stated the role/team cares about',
      max: 6,
    },
    {
      key: 'nextSteps',
      label: 'Next steps',
      guidance: 'what either side said would happen next, including timing when stated',
      max: 5,
    },
  ],
  subject: [
    {
      key: 'covered',
      label: 'Covered',
      guidance: 'the concepts, topics, or material actually worked through',
      max: 10,
    },
    {
      key: 'struggled',
      label: 'Did not land',
      guidance:
        'what the learner got wrong, asked twice, or explicitly said they did not follow — the single most useful thing to carry into the next session',
      max: 6,
    },
    { ...OPEN, label: 'Still unresolved' },
    {
      key: 'toReview',
      label: 'To review',
      guidance: 'anything named as needing practice or a second pass',
      max: 6,
    },
  ],
  personal: [
    DECISIONS,
    ACTIONS,
    OPEN,
    {
      key: 'dates',
      label: 'Dates and amounts',
      guidance:
        'concrete dates, deadlines, sums, and reference numbers stated in the conversation — the details that are painful to lose',
      max: 8,
    },
  ],
  game: [
    {
      key: 'progress',
      label: 'What happened',
      guidance: 'what was accomplished, reached, or failed in this session',
      max: 8,
    },
    { ...DECISIONS, label: 'Chose' },
    { ...OPEN, label: 'Unfinished' },
  ],
  solo: [
    { ...DECISIONS, label: 'Worked out' },
    { ...ACTIONS, label: 'To do', guidance: 'tasks the user said they would do' },
    OPEN,
  ],
  custom: CONVERSATION,
};

/** An unknown activity falls back to the conversation shape rather than
 *  throwing: a v1 row with no activity is still a conversation between people. */
export const archiveFormat = (kind: string | null | undefined): ArchiveSection[] =>
  ARCHIVE_FORMATS[kind as ContextPackKind] ?? ARCHIVE_FORMATS.custom;
