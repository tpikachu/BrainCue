import { describe, expect, it } from 'vitest';
import { normalizeAnswerFormat } from '@shared/types';
import { zAnswerFormat } from './schemas';

/**
 * v2.2 collapsed five answer formats into two styles (General | Technical).
 * A stored pref, an older renderer or an e2e script can still send the old
 * words, so both the pure normalizer and the IPC schema must map them rather
 * than reject them.
 */
describe('normalizeAnswerFormat', () => {
  it('passes the two live styles through', () => {
    expect(normalizeAnswerFormat('general')).toBe('general');
    expect(normalizeAnswerFormat('technical')).toBe('technical');
  });

  it('maps the five legacy formats', () => {
    expect(normalizeAnswerFormat('key_points')).toBe('general');
    expect(normalizeAnswerFormat('explanation')).toBe('general');
    expect(normalizeAnswerFormat('story_teller')).toBe('general');
    expect(normalizeAnswerFormat('star')).toBe('general');
    expect(normalizeAnswerFormat('detailed')).toBe('technical');
  });

  it('falls back to general for anything else', () => {
    expect(normalizeAnswerFormat('verbose')).toBe('general');
    expect(normalizeAnswerFormat(undefined)).toBe('general');
    expect(normalizeAnswerFormat(42)).toBe('general');
    expect(normalizeAnswerFormat('constructor')).toBe('general'); // not a prototype lookup
  });
});

describe('zAnswerFormat', () => {
  it('accepts the live styles', () => {
    expect(zAnswerFormat.parse('general')).toBe('general');
    expect(zAnswerFormat.parse('technical')).toBe('technical');
  });

  it('accepts and maps the legacy values', () => {
    expect(zAnswerFormat.parse('star')).toBe('general');
    expect(zAnswerFormat.parse('key_points')).toBe('general');
    expect(zAnswerFormat.parse('detailed')).toBe('technical');
  });

  it('still rejects a non-string', () => {
    expect(() => zAnswerFormat.parse(7)).toThrow();
  });
});
