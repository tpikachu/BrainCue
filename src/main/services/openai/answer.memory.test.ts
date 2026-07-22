import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, RetrievedMemory } from '@shared/types';

/** Memory in the answer prompt: absent → byte-identical v1 prompt (pinned by
 *  the main answer suite); present → ONE added MEMORY section with [M#]
 *  numbering kept separate from the [n] document-context numbers. */

const h = vi.hoisted(() => ({
  lastUser: '',
}));

vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    // eslint-disable-next-line require-yield
    stream: async function* (req: { user: string }) {
      h.lastUser = req.user;
      yield { type: 'delta', token: 'ok' };
      yield { type: 'usage', prompt: 1, completion: 1 };
    },
  }),
}));

import { buildMemoryBlock, streamAnswer } from './answer';

const profile = { targetRole: 'PM', targetCompany: null } as unknown as Profile;
const memories: RetrievedMemory[] = [
  { id: 'm1', category: 'preference', content: 'Prefers concise bullet answers.', score: 0.9 },
  { id: 'm2', category: 'project', content: 'Leads the checkout redesign.', score: 0.7 },
];

async function run(mem?: RetrievedMemory[]): Promise<string> {
  const gen = streamAnswer({
    question: 'How do you run meetings?',
    contextChunks: [],
    memories: mem,
    profile,
    format: 'key_points',
    pronunciation: false,
    interviewType: 'general',
  });
  for await (const _ of gen) {
    // drain
  }
  return h.lastUser;
}

beforeEach(() => {
  h.lastUser = '';
});

describe('buildMemoryBlock', () => {
  it('numbers memories as [M1], [M2]… with their categories', () => {
    expect(buildMemoryBlock(memories)).toBe(
      '[M1] (preference) Prefers concise bullet answers.\n\n[M2] (project) Leads the checkout redesign.',
    );
  });
});

describe('streamAnswer prompt', () => {
  it('adds the MEMORY section only when memories were recalled', async () => {
    const withMem = await run(memories);
    expect(withMem).toContain('MEMORY (the candidate\'s own saved notes');
    expect(withMem).toContain('[M1] (preference) Prefers concise bullet answers.');
    // Section order: CONTEXT → MEMORY → QUESTION.
    expect(withMem.indexOf('CONTEXT:')).toBeLessThan(withMem.indexOf('MEMORY ('));
    expect(withMem.indexOf('MEMORY (')).toBeLessThan(withMem.indexOf('QUESTION:'));
  });

  it('without memories the prompt has no MEMORY section (v1 byte-parity)', async () => {
    const withoutA = await run(undefined);
    expect(withoutA).not.toContain('MEMORY (');
    const withoutB = await run([]);
    expect(withoutA).toBe(withoutB); // undefined and [] are the same prompt
  });
});
