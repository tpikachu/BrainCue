import { providerFor } from '../../providers/registry';
import type { RealtimeSttCallbacks, RealtimeSttSession } from '../../providers/types';

/**
 * Source adapters normalize inputs into the engine. Today there is one live
 * audio source (the renderer streams PCM16 24 kHz mono over one-way IPC) and
 * it feeds the selected realtime-STT provider; screen/clipboard remain in
 * services/capture until the contribution-cards PR routes them through
 * ContextEvents. Dual-source (mic + system simultaneously) arrives with
 * Meeting mode — adapters keep source identity so that lands here, not in the
 * engine core.
 */
export type TranscriberCallbacks = RealtimeSttCallbacks;

export function createRealtimeSource(
  cb: TranscriberCallbacks,
  language: string,
): RealtimeSttSession {
  return providerFor('realtimeStt').open(cb, { language });
}

/** RMS level of one PCM16 frame (0–1) — drives the Cue Card audio meter.
 *  A malformed (odd-length) frame must not throw — Int16Array requires an even
 *  byte length, so floor to whole samples. */
export function pcmLevel(pcm: ArrayBuffer): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const samples = new Int16Array(pcm, 0, sampleCount);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
