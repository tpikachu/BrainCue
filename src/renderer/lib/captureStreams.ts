import { capturePlan } from '@shared/activities';
import type { AudioSource } from '@shared/types';

/**
 * Which streams a session ends up with, given what the activity wants
 * (shared/activities.ts `capturePlan`) and how each acquisition went. Pure —
 * useLiveSession does the `getDisplayMedia` / `getUserMedia` calls and hands
 * the outcomes here — so the degrade rules are unit-tested without a browser:
 *
 *  - A call hears BOTH the call and the microphone. If the system-audio
 *    picker is refused or captures no audio, the session goes on with the
 *    microphone alone and says so (`notice`, non-fatal). If the microphone is
 *    denied, it goes on with the call alone and says so.
 *  - A session with NEITHER stream does not start: the error thrown names
 *    both failures, and the caller never creates a session that shows "live"
 *    with nothing flowing.
 *  - A solo activity (`listensTo: 'mic'`) has one stream; its failure is fatal.
 */
export type Attempt<S> = { ok: true; stream: S } | { ok: false; error: string };

export interface ResolvedCapture<S> {
  streams: Partial<Record<AudioSource, S>>;
  /** Order to open the pumps in; the first one is the waveform's stream. */
  order: AudioSource[];
  /** Non-fatal degradation to surface (one stream missing), else null. */
  notice: string | null;
}

const MISSING: Record<AudioSource, string> = {
  system:
    'System audio was not captured, so BrainCue is listening to your microphone only — ' +
    'the other side of the call will not be transcribed or answered.',
  mic:
    'Microphone access was denied, so BrainCue is listening to the call only — ' +
    'your own words will not appear in the transcript.',
};

export function resolveCapture<S>(
  listensTo: 'system' | 'mic',
  attempts: Partial<Record<AudioSource, Attempt<S>>>,
): ResolvedCapture<S> {
  const plan = capturePlan(listensTo);
  const streams: Partial<Record<AudioSource, S>> = {};
  const order: AudioSource[] = [];
  const failures: { source: AudioSource; error: string }[] = [];
  for (const source of plan.streams) {
    const a = attempts[source];
    if (a?.ok) {
      streams[source] = a.stream;
      order.push(source);
    } else {
      failures.push({ source, error: a?.error ?? 'not attempted' });
    }
  }
  if (order.length === 0) {
    throw new Error(
      plan.streams.length === 1
        ? failures[0].error
        : `No audio captured. ${failures.map((f) => `${label(f.source)}: ${f.error}`).join(' ')}`,
    );
  }
  const missing = failures[0];
  return { streams, order, notice: missing ? MISSING[missing.source] : null };
}

const label = (s: AudioSource): string => (s === 'system' ? 'System audio' : 'Microphone');
