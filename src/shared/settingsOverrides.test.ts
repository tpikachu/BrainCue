import { describe, expect, it } from 'vitest';
import { mergeOverrides } from './settingsOverrides';

describe('mergeOverrides (one task edited against the stored map)', () => {
  const stored = { answer: 'anthropic/claude-haiku-5-5', coding: 'anthropic/claude-opus-5-5' };

  it('changes only the keys named — an effort-only or answer-only edit keeps every other override', () => {
    expect(mergeOverrides(stored, { answer: 'gpt-6-luna' })).toEqual({ answer: 'gpt-6-luna', coding: 'anthropic/claude-opus-5-5' });
    expect(mergeOverrides({ coding: 'low' }, { coding: 'high' })).toEqual({ coding: 'high' });
  });

  it('clears a key with null or an empty string (→ Automatic)', () => {
    expect(mergeOverrides(stored, { coding: null })).toEqual({ answer: 'anthropic/claude-haiku-5-5' });
    expect(mergeOverrides(stored, { coding: '  ' })).toEqual({ answer: 'anthropic/claude-haiku-5-5' });
  });

  it('does not mutate the stored map', () => {
    const s = { ...stored };
    mergeOverrides(s, { coding: null });
    expect(s).toEqual(stored);
  });
});
