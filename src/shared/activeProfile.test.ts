import { describe, expect, it } from 'vitest';
import { resolveActiveProfile } from './activeProfile';

/**
 * The stored active profile is a pointer, and pointers dangle: profiles get
 * deleted, databases get restored, the setting outlives the row it names. The
 * whole dashboard is scoped by this one value, so a dangling id would blank
 * every list at once — and "empty" is indistinguishable from "broken".
 */
describe('resolveActiveProfile', () => {
  it('keeps the stored choice when it still exists', () => {
    expect(resolveActiveProfile('b', ['a', 'b', 'c'])).toBe('b');
  });

  it('falls back to a profile that EXISTS when the stored one is gone', () => {
    // Deleting the active profile must not leave the app looking empty.
    expect(resolveActiveProfile('deleted', ['a', 'b'])).toBe('a');
  });

  it('falls back when nothing was ever stored', () => {
    expect(resolveActiveProfile(null, ['a'])).toBe('a');
    expect(resolveActiveProfile(undefined, ['a'])).toBe('a');
    expect(resolveActiveProfile('', ['a'])).toBe('a');
  });

  it('returns null ONLY when there are genuinely no profiles', () => {
    // This is the signal the first-run gate keys off. Returning a stale id here
    // would hide the "create a profile" modal behind a dashboard of empty lists.
    expect(resolveActiveProfile('deleted', [])).toBeNull();
    expect(resolveActiveProfile(null, [])).toBeNull();
  });
});
