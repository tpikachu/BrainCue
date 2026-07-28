import { describe, expect, it } from 'vitest';
import { SPACE_KINDS, SPACE_KIND_ORDER, isInterviewSpace, spaceKind } from './spaceKinds';

/**
 * A Space is the bundle of context a conversation is grounded in. Its fields
 * were named for a job interview, which is why `ContextPackKind` existed in the
 * types and meant nothing in the product. These pin the two things that would
 * quietly regress: every kind must actually have its own words, and the
 * interview-only machinery must stay behind the gate.
 */

describe('space kinds', () => {
  it('covers every kind in the picker, and none twice', () => {
    expect([...SPACE_KIND_ORDER].sort()).toEqual(Object.keys(SPACE_KINDS).sort());
    expect(new Set(SPACE_KIND_ORDER).size).toBe(SPACE_KIND_ORDER.length);
  });

  it('gives each kind its own vocabulary — no kind is left speaking about jobs', () => {
    for (const kind of SPACE_KIND_ORDER) {
      const c = SPACE_KINDS[kind];
      for (const [field, text] of Object.entries(c)) {
        if (typeof text !== 'string') continue;
        if (kind === 'job') continue; // the job kind SHOULD say job things
        expect(text.toLowerCase(), `${kind}.${field}`).not.toMatch(
          /job description|interview|résumé|resume|candidate/,
        );
      }
    }
  });

  it('falls back to the generic kind rather than throwing on an unknown one', () => {
    // v1 rows, hand-edited databases, and future kinds all land here.
    expect(spaceKind('not-a-kind')).toBe(SPACE_KINDS.custom);
    expect(spaceKind(null)).toBe(SPACE_KINDS.custom);
    expect(spaceKind(undefined)).toBe(SPACE_KINDS.custom);
    expect(spaceKind('meeting')).toBe(SPACE_KINDS.meeting);
  });

  it('treats only the job kind as an interview', () => {
    expect(isInterviewSpace('job')).toBe(true);
    for (const kind of SPACE_KIND_ORDER.filter((k) => k !== 'job')) {
      expect(isInterviewSpace(kind), kind).toBe(false);
    }
    expect(isInterviewSpace(null)).toBe(false);
  });
});
