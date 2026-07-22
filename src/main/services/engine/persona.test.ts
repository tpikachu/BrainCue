import { describe, expect, it } from 'vitest';
import {
  buildPersonaPreamble,
  DEFAULT_COMPANION_PREFS,
  mergePersonality,
} from './persona';
import type { CompanionPersonality } from '@shared/types';

const base: CompanionPersonality = {
  name: 'BrainCue',
  voice: null,
  tone: 'warm',
  brevity: 'normal',
  humor: false,
};

describe('mergePersonality', () => {
  it('null/absent overrides inherit everything', () => {
    expect(mergePersonality(base, null)).toEqual(base);
    expect(mergePersonality(base, undefined)).toEqual(base);
    expect(mergePersonality(base, {})).toEqual(base);
  });

  it('overrides win field-by-field; untouched fields inherit', () => {
    const merged = mergePersonality(base, { tone: 'direct', humor: true });
    expect(merged).toEqual({ ...base, tone: 'direct', humor: true });
  });

  it('presence in the overrides does not leak into the personality', () => {
    const merged = mergePersonality(base, { presence: 'off', brevity: 'terse' });
    expect(merged).toEqual({ ...base, brevity: 'terse' });
    expect('presence' in merged).toBe(false);
  });
});

describe('buildPersonaPreamble', () => {
  it('is deterministic — identical config renders identical text', () => {
    expect(buildPersonaPreamble(base)).toBe(buildPersonaPreamble({ ...base }));
  });

  it('renders every dial: name, tone, brevity, humor', () => {
    const text = buildPersonaPreamble({
      name: 'Ada',
      voice: null,
      tone: 'direct',
      brevity: 'terse',
      humor: true,
    });
    expect(text).toContain('Your name is Ada.');
    expect(text).toContain('Direct and to the point');
    expect(text).toContain('one or two sentences');
    expect(text).toContain('Light humor is welcome');
  });

  it('humor off forbids jokes explicitly', () => {
    expect(buildPersonaPreamble(base)).toContain('no jokes');
  });

  it('the default prefs render without placeholders', () => {
    const text = buildPersonaPreamble(DEFAULT_COMPANION_PREFS.personality);
    expect(text).toContain('Your name is BrainCue.');
    expect(text).not.toContain('undefined');
  });
});
