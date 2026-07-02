import { describe, it, expect } from 'vitest';
import { wordDiff, type DiffSegment } from './wordDiff';

const text = (segs: DiffSegment[], ops: string[]) =>
  segs
    .filter((s) => ops.includes(s.op))
    .map((s) => s.text)
    .join('');

describe('wordDiff', () => {
  it('marks identical text as one same segment per side', () => {
    const d = wordDiff('led the team', 'led the team')!;
    expect(d.base).toEqual([{ op: 'same', text: 'led the team ' }]);
    expect(d.revised).toEqual([{ op: 'same', text: 'led the team ' }]);
  });

  it('marks a replacement as del (base) + add (revised) between same runs', () => {
    const d = wordDiff('cut latency 20% at Acme', 'cut latency 40% at Acme')!;
    expect(d.base.map((s) => s.op)).toEqual(['same', 'del', 'same']);
    expect(text(d.base, ['del']).trim()).toBe('20%');
    expect(d.revised.map((s) => s.op)).toEqual(['same', 'add', 'same']);
    expect(text(d.revised, ['add']).trim()).toBe('40%');
  });

  it('handles pure additions and pure deletions', () => {
    const add = wordDiff('built APIs', 'built scalable APIs')!;
    expect(text(add.revised, ['add']).trim()).toBe('scalable');
    expect(add.base.every((s) => s.op === 'same')).toBe(true);

    const del = wordDiff('built scalable APIs', 'built APIs')!;
    expect(text(del.base, ['del']).trim()).toBe('scalable');
    expect(del.revised.every((s) => s.op === 'same')).toBe(true);
  });

  it('preserves newlines so paragraph structure survives rendering', () => {
    const d = wordDiff('line one\nline two', 'line one\nline two')!;
    expect(d.base[0].text).toContain('\n');
    expect(text(d.base, ['same'])).toBe('line one \nline two ');
  });

  it('reconstructs each side fully from its segments (no lost words)', () => {
    const d = wordDiff('a b c d', 'a x c y d z')!;
    expect(text(d.base, ['same', 'del'])).toBe('a b c d ');
    expect(text(d.revised, ['same', 'add'])).toBe('a x c y d z ');
  });

  it('returns null for inputs too large to diff (caller falls back)', () => {
    const huge = 'word '.repeat(2100);
    expect(wordDiff(huge, huge)).toBeNull();
  });
});
