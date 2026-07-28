import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which FRAMING each mode asks the shared generator for.
 *
 * `answer.test.ts` proves the two framings render correctly; this proves the
 * modes are actually wired to the right one — the gap that let a summoned
 * answer in a standup arrive written as an interview pitch for a year. Flipping
 * `meeting.mode.ts` back to the interview framing must fail a test, not just
 * read wrong.
 */

const h = vi.hoisted(() => ({ system: '', user: '' }));

vi.mock('../../../providers/registry', () => ({
  providerFor: () => ({
    stream: async function* (req: { system: string; user: string }) {
      h.system = req.system;
      h.user = req.user;
      yield { type: 'delta' as const, token: 'ok' };
    },
  }),
}));
// meeting.mode imports grounding → retriever → vectorStore → db. `generate`
// never touches it; the mock just keeps module loading free of a real database.
vi.mock('../../../db', async () => {
  const schema = await vi.importActual<typeof import('../../../db/schema')>('../../../db/schema');
  return {
    schema,
    db: () => {
      throw new Error('db not used in this suite');
    },
    initDb: () => null,
    rawDb: () => {
      throw new Error('rawDb not used in this suite');
    },
  };
});

import { meetingMode } from './meeting.mode';
import type { GenerateInput } from '../modeDefinition';

const input = {
  question: 'Where did we land on the renewal?',
  contextChunks: [{ id: 'c1', sourceType: 'note' as const, content: 'Renewal is quarterly', score: 0.8 }],
  memories: [],
  profile: { name: 'Sam', targetRole: 'SWE', targetCompany: 'Acme' },
  settings: { answerFormat: 'key_points', interviewType: 'behavioral', pronunciation: true },
} as unknown as GenerateInput;

beforeEach(() => {
  h.system = '';
  h.user = '';
});

describe('meeting mode framing', () => {
  it('asks for the CONVERSATION framing — nobody in a meeting is being assessed', async () => {
    for await (const _ of meetingMode.generate(input)) void _;
    expect(h.system).not.toContain('candidate');
    expect(h.system).not.toContain('interviewer');
    expect(h.system).toContain('live conversation');
  });

  it('sends no interview scaffolding in the user prompt', async () => {
    for await (const _ of meetingMode.generate(input)) void _;
    expect(h.user).not.toContain('Interview type:');
    expect(h.user).not.toContain('Candidate role target:');
  });
});
