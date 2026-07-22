import { describe, expect, it, vi } from 'vitest';

// Pure-function tests only: the db and provider registry must not be touched.
vi.mock('../../db', () => ({
  db: () => {
    throw new Error('db must not be reached from pure meetingReport tests');
  },
  schema: {},
}));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    json: async () => {
      throw new Error('provider must not be reached from pure meetingReport tests');
    },
  }),
}));

import { groundReport, meetingReportSchema, renderMeetingReport } from './meetingReport';
import type { MeetingReport } from '@shared/types';

const TRANSCRIPT = [
  'them: What is our budget for the Q3 campaign?',
  'them: I will send the launch checklist by Friday.',
  'them: We have decided to go with the phased rollout.',
].join('\n');

describe('groundReport — owners/dates survive only if the transcript said them', () => {
  it('nulls invented owners and deadlines, keeps explicit ones', () => {
    const raw: MeetingReport = {
      summary: 'Launch planning sync.',
      decisions: [{ text: 'Phased rollout', owner: 'Bob' }], // Bob never spoke
      actionItems: [
        { text: 'Send launch checklist', owner: 'Alice', deadline: 'by Friday' }, // Friday IS in the transcript
        { text: 'Draft pricing one-pager', owner: null, deadline: 'March 3rd' }, // invented date
      ],
      openQuestions: ['What is our budget for the Q3 campaign?'],
    };
    const grounded = groundReport(raw, TRANSCRIPT);
    expect(grounded.decisions[0].owner).toBeNull();
    expect(grounded.actionItems[0].owner).toBeNull(); // "Alice" not in transcript
    expect(grounded.actionItems[0].deadline).toBe('by Friday'); // explicit → kept
    expect(grounded.actionItems[1].deadline).toBeNull(); // invented → nulled
    expect(grounded.openQuestions).toHaveLength(1); // content untouched
  });

  it('keeps an owner who was explicitly named', () => {
    const grounded = groundReport(
      {
        summary: '',
        decisions: [],
        actionItems: [{ text: 'Update deck', owner: 'Sam', deadline: null }],
        openQuestions: [],
      },
      'them: Sam will update the deck.',
    );
    expect(grounded.actionItems[0].owner).toBe('Sam');
  });
});

describe('meetingReportSchema', () => {
  it('accepts the canonical shape and defaults missing lists', () => {
    const parsed = meetingReportSchema.parse({ summary: 'Short sync.' });
    expect(parsed).toEqual({ summary: 'Short sync.', decisions: [], actionItems: [], openQuestions: [] });
  });

  it('rejects malformed items', () => {
    expect(() => meetingReportSchema.parse({ summary: 1 })).toThrow();
    expect(() =>
      meetingReportSchema.parse({ summary: '', actionItems: [{ owner: 'x' }] }),
    ).toThrow(); // text is required
  });
});

describe('renderMeetingReport', () => {
  it('renders every section, omitting empty ones', () => {
    const md = renderMeetingReport({
      summary: 'Launch planning sync.',
      decisions: [{ text: 'Phased rollout', owner: null }],
      actionItems: [{ text: 'Send checklist', owner: null, deadline: 'by Friday' }],
      openQuestions: [],
    });
    expect(md).toContain('Launch planning sync.');
    expect(md).toContain('## Decisions');
    expect(md).toContain('- Send checklist — by Friday');
    expect(md).not.toContain('## Open questions');
  });
});
