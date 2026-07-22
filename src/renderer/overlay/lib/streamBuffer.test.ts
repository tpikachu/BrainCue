import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamBuffer } from './streamBuffer';

/** rAF stub: collect callbacks; runFrame() fires them like one animation frame. */
let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(0));
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames = frames.filter((_, i) => i !== id - 1);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('createStreamBuffer', () => {
  it('coalesces a burst of tokens into ONE flush per frame, concatenated per id', () => {
    const flushes: [string, string][][] = [];
    const buf = createStreamBuffer((chunks) => flushes.push(chunks));

    buf.push('a', 'He');
    buf.push('a', 'llo');
    buf.push('b', 'Hi');
    expect(flushes).toHaveLength(0); // nothing until the frame fires
    expect(frames).toHaveLength(1); // one scheduled frame for the whole burst

    runFrame();
    expect(flushes).toEqual([
      [
        ['a', 'Hello'],
        ['b', 'Hi'],
      ],
    ]);
  });

  it('interleaved streams stay in their own lanes across frames', () => {
    const flushes: [string, string][][] = [];
    const buf = createStreamBuffer((chunks) => flushes.push(chunks));

    buf.push('live', 'Use a ');
    buf.push('solve', 'function');
    runFrame();
    buf.push('live', 'hashmap');
    runFrame();

    expect(flushes).toEqual([
      [
        ['live', 'Use a '],
        ['solve', 'function'],
      ],
      [['live', 'hashmap']],
    ]);
  });

  it('drop(id) discards ONLY that stream’s buffered tokens', () => {
    const flushes: [string, string][][] = [];
    const buf = createStreamBuffer((chunks) => flushes.push(chunks));

    buf.push('a', 'stale');
    buf.push('b', 'kept');
    buf.drop('a');
    runFrame();
    expect(flushes).toEqual([[['b', 'kept']]]);
  });

  it('flush() delivers synchronously; the later frame is then a no-op', () => {
    const flushes: [string, string][][] = [];
    const buf = createStreamBuffer((chunks) => flushes.push(chunks));

    buf.push('a', 'now');
    buf.flush();
    expect(flushes).toEqual([[['a', 'now']]]);
    runFrame(); // the originally scheduled frame fires with nothing pending
    expect(flushes).toHaveLength(1);
  });

  it('cancel() clears every lane and the scheduled frame', () => {
    const flushes: [string, string][][] = [];
    const buf = createStreamBuffer((chunks) => flushes.push(chunks));

    buf.push('a', 'gone');
    buf.push('b', 'gone too');
    buf.cancel();
    runFrame();
    expect(flushes).toHaveLength(0);
  });
});
