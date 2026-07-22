import { describe, expect, it } from 'vitest';
import { pcm16ToWav } from './wav';

describe('pcm16ToWav', () => {
  it('writes a valid mono 16-bit RIFF header around the frames', () => {
    const frames = [Buffer.alloc(1000, 1), Buffer.alloc(500, 2)];
    const wav = pcm16ToWav(frames, 24000);
    expect(wav.length).toBe(44 + 1500);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 1500);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(1500); // data length
    expect(wav[44]).toBe(1); // payload follows the header verbatim
    expect(wav[44 + 1000]).toBe(2);
  });
});
