import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the provider registry wholesale — importing it for real drags in the
// OpenAI client chain (realtime → apiKey → electron).
const jsonMock = vi.fn();
vi.mock('../../../providers/registry', () => ({
  providerFor: () => ({ json: (req: unknown) => jsonMock(req) }),
}));

import { classifyCompanionSalience, companionSalienceSchema } from './companionSalience';

// Braces matter: mockReset() returns the mock, and a value RETURNED from
// beforeEach is treated as a cleanup callback — vitest would then CALL the
// mock after each test (detonating throwing implementations).
beforeEach(() => {
  jsonMock.mockReset();
});

describe('classifyCompanionSalience', () => {
  it('returns the validated result for a well-formed response', async () => {
    jsonMock.mockResolvedValue({
      salient: true,
      kind: 'memory_suggestion',
      confidence: 0.8,
      relevance: 0.7,
      title: 'You saved a preference about this',
    });
    const r = await classifyCompanionSalience('turn', ['prior'], null);
    expect(r).toMatchObject({ salient: true, kind: 'memory_suggestion', relevance: 0.7 });
  });

  it('an invalid shape is SILENCE (null), never a guess', async () => {
    jsonMock.mockResolvedValue({ salient: 'yes', kind: 'context' }); // wrong types
    expect(await classifyCompanionSalience('turn', [], null)).toBeNull();
  });

  it('an unknown kind is silence', async () => {
    jsonMock.mockResolvedValue({
      salient: true,
      kind: 'decision', // a MEETING kind — not companion vocabulary
      confidence: 0.9,
      relevance: 0.9,
      title: 'x',
    });
    expect(await classifyCompanionSalience('turn', [], null)).toBeNull();
  });

  it('a classifier failure is silence', async () => {
    jsonMock.mockImplementation(() => {
      throw new Error('network down');
    });
    expect(await classifyCompanionSalience('turn', [], null)).toBeNull();
  });

  it('includes the active context in the prompt only when provided', async () => {
    jsonMock.mockResolvedValue(null);
    await classifyCompanionSalience('the turn', ['a'], 'editor: notes.md');
    expect((jsonMock.mock.calls[0][0] as { user: string }).user).toContain(
      'Active context: editor: notes.md',
    );
    await classifyCompanionSalience('the turn', ['a'], null);
    expect((jsonMock.mock.calls[1][0] as { user: string }).user).not.toContain('Active context');
  });

  it('runs on the classify-tier task', async () => {
    jsonMock.mockResolvedValue(null);
    await classifyCompanionSalience('turn', [], null);
    expect((jsonMock.mock.calls[0][0] as { task: string }).task).toBe('classify');
  });
});

describe('companionSalienceSchema', () => {
  it('bounds confidence and relevance to [0,1]', () => {
    const bad = companionSalienceSchema.safeParse({
      salient: true,
      kind: 'context',
      confidence: 1.4,
      relevance: 0.5,
      title: '',
    });
    expect(bad.success).toBe(false);
  });
});
