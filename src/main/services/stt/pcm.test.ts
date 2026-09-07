import { describe, expect, it } from 'vitest';
import { pcm16ToFloat32, resampleLinear, toStandaloneArrayBuffer } from './pcm';

describe('pcm16ToFloat32', () => {
  it('maps little-endian int16 to [-1, 1)', () => {
    const buf = new ArrayBuffer(8);
    const v = new DataView(buf);
    v.setInt16(0, 0, true);
    v.setInt16(2, 32767, true);
    v.setInt16(4, -32768, true);
    v.setInt16(6, 16384, true);
    const out = pcm16ToFloat32(buf);
    expect(Array.from(out)).toEqual([0, 32767 / 32768, -1, 0.5]);
  });

  it('accepts a Uint8Array view with an offset and ignores an odd trailing byte', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x40, 0x00, 0x00, 0x7f]); // 3 bytes at offset 1: 0x0040, 0x00 (odd)
    const out = pcm16ToFloat32(bytes.subarray(1, 6));
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0x4000 / 32768, 6);
  });
});

describe('resampleLinear', () => {
  it('returns the input untouched when rates match', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('24k -> 16k yields 2/3 of the samples and interpolates between neighbours', () => {
    const input = new Float32Array(24); // ramp 0..23
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = resampleLinear(input, 24000, 16000);
    expect(out.length).toBe(16);
    // output i sits at input position i*1.5 → a straight ramp stays a ramp
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(i * 1.5, 5);
  });

  it('a 1 kHz sine at 24 kHz is still a 1 kHz sine at 16 kHz', () => {
    const input = new Float32Array(2400);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 24000);
    const out = resampleLinear(input, 24000, 16000);
    expect(out.length).toBe(1600);
    let maxErr = 0;
    for (let i = 0; i < out.length; i++) {
      const expected = Math.sin((2 * Math.PI * 1000 * i) / 16000);
      maxErr = Math.max(maxErr, Math.abs(out[i] - expected));
    }
    expect(maxErr).toBeLessThan(0.02);
  });

  it('empty input stays empty', () => {
    expect(resampleLinear(new Float32Array(0), 24000, 16000).length).toBe(0);
  });
});

describe('toStandaloneArrayBuffer', () => {
  it('copies exactly the view bytes out of a pooled Buffer', () => {
    const b = Buffer.from('hello world', 'utf8'); // small → pooled, byteOffset likely > 0
    const view = b.subarray(6);
    const ab = toStandaloneArrayBuffer(view);
    expect(ab.byteLength).toBe(5);
    expect(Buffer.from(ab).toString()).toBe('world');
  });
});
