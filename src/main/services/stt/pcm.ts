/**
 * Pure PCM helpers for the local STT worker — kept free of the native addon
 * so they unit-test in plain Node (pcm.test.ts).
 *
 * The app captures PCM16 mono at 24 kHz (the OpenAI Realtime format); the
 * Nemotron exports were trained on 16 kHz. The worker prefers the addon's
 * stateful `LinearResampler` (it carries the fractional phase across chunks);
 * `resampleLinear` here is the fallback when the addon lacks it.
 */

export const APP_SAMPLE_RATE = 24_000;
export const MODEL_SAMPLE_RATE = 16_000;

/** Little-endian signed 16-bit PCM → Float32 in [-1, 1). An odd trailing byte is ignored. */
export function pcm16ToFloat32(pcm: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * Stateless linear-interpolation resampler. Good enough for speech at a 3:2
 * ratio (24k → 16k); each chunk is treated independently, so a hairline
 * discontinuity can occur at chunk boundaries — the addon resampler avoids
 * that and is used when available.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    out[i] = input[i0] + (input[i1] - input[i0]) * frac;
  }
  return out;
}

/** Copy a Buffer's bytes into a standalone ArrayBuffer (Buffers may share a pool). */
export function toStandaloneArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
