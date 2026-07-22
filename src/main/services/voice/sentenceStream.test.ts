import { describe, expect, it } from 'vitest';
import { SentenceStream, speechText } from './sentenceStream';

describe('speechText', () => {
  it('strips citations and markdown the TTS would read aloud', () => {
    expect(speechText('**Bold** move [1], `code` and [M2] done.')).toBe('Bold move , code and done.');
  });

  it('drops bullet markers', () => {
    expect(speechText('- first point')).toBe('first point');
  });
});

describe('SentenceStream', () => {
  it('emits a sentence as soon as its boundary streams past', () => {
    const s = new SentenceStream();
    expect(s.push('The first sentence')).toEqual([]);
    expect(s.push(' is here. And')).toEqual(['The first sentence is here.']);
    expect(s.flush()).toBe('And');
  });

  it('holds the tail until flush', () => {
    const s = new SentenceStream();
    s.push('A complete thought lands here. But this trails');
    expect(s.flush()).toBe('But this trails');
    expect(s.flush()).toBeNull(); // drained
  });

  it('does not split decimals ("3.5" has no space after the dot)', () => {
    const s = new SentenceStream();
    const out = s.push('It costs 3.5 dollars in total. Next');
    expect(out).toEqual(['It costs 3.5 dollars in total.']);
  });

  it('merges too-short fragments into the following sentence', () => {
    const s = new SentenceStream();
    // "1." alone is not worth a synthesis round-trip.
    const out = s.push('1. Ship the release notes today. ');
    expect(out).toEqual(['1. Ship the release notes today.']);
  });

  it('treats newlines as sentence pauses', () => {
    const s = new SentenceStream();
    const out = s.push('First bullet point here\nsecond one');
    expect(out).toEqual(['First bullet point here']);
    expect(s.flush()).toBe('second one');
  });

  it('force-flushes a very long boundary-less run so speech never stalls', () => {
    const s = new SentenceStream();
    const out = s.push('word '.repeat(90)); // 450 chars, no terminator
    expect(out).toHaveLength(1);
    expect(s.flush()).toBeNull();
  });

  it('a citation-only fragment synthesizes nothing', () => {
    const s = new SentenceStream();
    s.push('[1] [M1] ****');
    expect(s.flush()).toBeNull();
  });
});
