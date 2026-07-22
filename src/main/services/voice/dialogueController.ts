import type { VoiceState } from '@shared/types';

/**
 * The voice dialogue controller: an EXPLICIT finite state machine. Every
 * voice-layer behavior (push-to-talk, barge-in, cancel-at-every-stage, the
 * text-only fallback) is a transition in this table — the orchestrator
 * (voiceService) performs side effects only in RESPONSE to transitions, so the
 * reachable states are enumerable and testable without audio or a model.
 *
 * Pure by design: no Electron, no providers, no timers.
 */

/** Events the orchestrator can feed the machine. */
export type VoiceFsmEvent =
  | 'SUMMON' // the push-to-talk press (hotkey or mic button)
  | 'COMMIT' // end of capture (silence VAD or explicit send)
  | 'CANCEL' // user abandons the turn
  | 'SPEAK' // first synthesized segment is ready to play
  | 'TEXT_DONE' // reply finished without speech (muted / no speech capability)
  | 'PLAYBACK_DONE' // renderer finished the final segment
  | 'INTERRUPT' // barge-in while speaking
  | 'PAUSE'
  | 'RESUME'
  | 'FAIL' // STT/generation/synthesis error
  | 'RESET'; // error acknowledged / cleared

/** Transition table. Anything not listed is an ignored (invalid) event —
 *  transition() returns null and the machine stays put. */
const TRANSITIONS: Record<VoiceState, Partial<Record<VoiceFsmEvent, VoiceState>>> = {
  idle: { SUMMON: 'listening', PAUSE: 'paused' },
  listening: {
    SUMMON: 'thinking', // second press = send (push-to-talk toggle)
    COMMIT: 'thinking',
    CANCEL: 'idle',
    PAUSE: 'paused',
    FAIL: 'error',
  },
  thinking: {
    SPEAK: 'speaking',
    TEXT_DONE: 'idle',
    CANCEL: 'idle',
    SUMMON: 'listening', // press during thinking = abandon + re-listen
    PAUSE: 'paused',
    FAIL: 'error',
  },
  speaking: {
    PLAYBACK_DONE: 'idle',
    INTERRUPT: 'interrupted',
    SUMMON: 'interrupted', // press while speaking = barge-in
    CANCEL: 'idle',
    PAUSE: 'paused',
    FAIL: 'error',
  },
  // Transient: barge-in lands here, and the orchestrator immediately re-enters
  // listening (a new capture) — kept as a REAL state so the UI can flash it and
  // tests can pin the path speaking → interrupted → listening.
  interrupted: { SUMMON: 'listening', CANCEL: 'idle', PAUSE: 'paused' },
  paused: { RESUME: 'idle', CANCEL: 'idle' },
  error: { RESET: 'idle', SUMMON: 'listening', CANCEL: 'idle' },
};

/** Events that begin a NEW turn — the generation counter bumps so everything
 *  in flight from the previous turn (STT, generation, queued TTS segments)
 *  becomes stale and is dropped wherever it next checks. */
const GENERATION_BUMPS: VoiceFsmEvent[] = ['SUMMON', 'CANCEL', 'INTERRUPT', 'PAUSE', 'FAIL'];

export function transition(state: VoiceState, event: VoiceFsmEvent): VoiceState | null {
  return TRANSITIONS[state][event] ?? null;
}

export interface VoiceTransition {
  from: VoiceState;
  to: VoiceState;
  event: VoiceFsmEvent;
  generation: number;
}

/**
 * Stateful wrapper: current state + the turn generation counter, notifying a
 * single listener on every applied transition. Invalid events are no-ops (and
 * return false) — the machine can never be driven into an undeclared state.
 */
export class DialogueController {
  private state: VoiceState = 'idle';
  private generation = 0;

  constructor(private onTransition?: (t: VoiceTransition) => void) {}

  get current(): VoiceState {
    return this.state;
  }

  get turn(): number {
    return this.generation;
  }

  /** Apply an event. Returns the applied transition, or null if invalid. */
  apply(event: VoiceFsmEvent): VoiceTransition | null {
    const next = transition(this.state, event);
    if (next === null) return null;
    if (GENERATION_BUMPS.includes(event)) this.generation += 1;
    const t: VoiceTransition = { from: this.state, to: next, event, generation: this.generation };
    this.state = next;
    this.onTransition?.(t);
    return t;
  }
}
