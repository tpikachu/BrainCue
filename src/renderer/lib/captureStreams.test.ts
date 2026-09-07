import { describe, expect, it } from 'vitest';
import { resolveCapture } from './captureStreams';

/**
 * The degrade rules for a session's audio, without a browser: a call wants
 * the call AND the microphone; losing one is a notice, losing both is a
 * refusal to start. useLiveSession only does the getDisplayMedia /
 * getUserMedia calls and hands the outcomes here.
 */

const ok = (name: string) => ({ ok: true as const, stream: name });
const denied = (error: string) => ({ ok: false as const, error });

describe('resolveCapture — a call', () => {
  it('opens both streams, the call first (it is the primary / waveform stream)', () => {
    const r = resolveCapture('system', { system: ok('loopback'), mic: ok('mic') });
    expect(r.streams).toEqual({ system: 'loopback', mic: 'mic' });
    expect(r.order).toEqual(['system', 'mic']);
    expect(r.notice).toBeNull();
  });

  it('a refused system-audio picker continues with the microphone alone, and says so', () => {
    const r = resolveCapture('system', {
      system: denied('Permission denied'),
      mic: ok('mic'),
    });
    expect(r.streams).toEqual({ mic: 'mic' });
    expect(r.order).toEqual(['mic']);
    expect(r.notice).toMatch(/System audio was not captured/);
    expect(r.notice).toMatch(/microphone only/);
  });

  it('a denied microphone continues with the call alone, and says so', () => {
    const r = resolveCapture('system', { system: ok('loopback'), mic: denied('NotAllowedError') });
    expect(r.streams).toEqual({ system: 'loopback' });
    expect(r.notice).toMatch(/Microphone access was denied/);
    expect(r.notice).toMatch(/call only/);
  });

  it('with NEITHER stream the session does not start, and the error names both failures', () => {
    expect(() =>
      resolveCapture('system', {
        system: denied('picker cancelled'),
        mic: denied('no microphone found'),
      }),
    ).toThrow(/System audio: picker cancelled.*Microphone: no microphone found/);
  });

  it('a stream that was never attempted counts as missing', () => {
    const r = resolveCapture('system', { mic: ok('mic') });
    expect(r.order).toEqual(['mic']);
    expect(r.notice).toMatch(/System audio/);
  });
});

describe('resolveCapture — a solo session', () => {
  it('is the microphone alone, with no notice', () => {
    const r = resolveCapture('mic', { mic: ok('mic') });
    expect(r.streams).toEqual({ mic: 'mic' });
    expect(r.order).toEqual(['mic']);
    expect(r.notice).toBeNull();
  });

  it('never opens system audio even if one was offered', () => {
    const r = resolveCapture('mic', { system: ok('loopback'), mic: ok('mic') });
    expect(r.streams).toEqual({ mic: 'mic' });
  });

  it('a denied microphone is fatal, with the original error', () => {
    expect(() => resolveCapture('mic', { mic: denied('NotAllowedError') })).toThrow('NotAllowedError');
  });
});
