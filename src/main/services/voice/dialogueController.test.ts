import { describe, expect, it } from 'vitest';
import { DialogueController, transition, type VoiceFsmEvent } from './dialogueController';
import type { VoiceState } from '@shared/types';

/**
 * The dialogue state machine (Prompt 9): every reachable state and the
 * cancel-at-every-stage guarantee are pinned here, table-first — the
 * orchestrator can only produce sequences this table allows.
 */

describe('transition table', () => {
  it('drives the happy path: summon → listen → commit → think → speak → done', () => {
    expect(transition('idle', 'SUMMON')).toBe('listening');
    expect(transition('listening', 'COMMIT')).toBe('thinking');
    expect(transition('thinking', 'SPEAK')).toBe('speaking');
    expect(transition('speaking', 'PLAYBACK_DONE')).toBe('idle');
  });

  it('push-to-talk toggle: a second press while listening sends', () => {
    expect(transition('listening', 'SUMMON')).toBe('thinking');
  });

  it('barge-in: speaking is interruptible by press or speech', () => {
    expect(transition('speaking', 'INTERRUPT')).toBe('interrupted');
    expect(transition('speaking', 'SUMMON')).toBe('interrupted');
    expect(transition('interrupted', 'SUMMON')).toBe('listening');
  });

  it('text-only fallback: thinking resolves without ever speaking', () => {
    expect(transition('thinking', 'TEXT_DONE')).toBe('idle');
  });

  it('cancel works at every active stage', () => {
    for (const s of ['listening', 'thinking', 'speaking', 'interrupted', 'paused', 'error']) {
      expect(transition(s as VoiceState, 'CANCEL')).toBe('idle');
    }
  });

  it('errors are recoverable: reset or a fresh summon', () => {
    expect(transition('thinking', 'FAIL')).toBe('error');
    expect(transition('error', 'RESET')).toBe('idle');
    expect(transition('error', 'SUMMON')).toBe('listening');
  });

  it('pause wins and only resume leaves it', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking']) {
      expect(transition(s as VoiceState, 'PAUSE')).toBe('paused');
    }
    expect(transition('paused', 'RESUME')).toBe('idle');
    expect(transition('paused', 'SUMMON')).toBeNull(); // no capture while paused
  });

  it('rejects undeclared moves (the machine cannot be driven off the table)', () => {
    const invalid: [VoiceState, VoiceFsmEvent][] = [
      ['idle', 'COMMIT'],
      ['idle', 'PLAYBACK_DONE'],
      ['idle', 'INTERRUPT'],
      ['idle', 'TEXT_DONE'],
      ['thinking', 'PLAYBACK_DONE'],
      ['thinking', 'COMMIT'],
      ['listening', 'SPEAK'],
      ['speaking', 'SPEAK'],
      ['error', 'COMMIT'],
    ];
    for (const [s, e] of invalid) expect(transition(s, e)).toBeNull();
  });
});

describe('DialogueController', () => {
  it('applies transitions, notifies, and no-ops on invalid events', () => {
    const seen: string[] = [];
    const c = new DialogueController((t) => seen.push(`${t.from}>${t.to}:${t.event}`));
    expect(c.current).toBe('idle');
    expect(c.apply('COMMIT')).toBeNull(); // invalid from idle
    expect(c.current).toBe('idle');
    c.apply('SUMMON');
    c.apply('COMMIT');
    expect(c.current).toBe('thinking');
    expect(seen).toEqual(['idle>listening:SUMMON', 'listening>thinking:COMMIT']);
  });

  it('bumps the generation on turn-starting events only', () => {
    const c = new DialogueController();
    expect(c.turn).toBe(0);
    c.apply('SUMMON'); // new turn
    expect(c.turn).toBe(1);
    c.apply('COMMIT'); // same turn
    c.apply('SPEAK');
    expect(c.turn).toBe(1);
    c.apply('INTERRUPT'); // barge-in: stale everything from turn 1
    expect(c.turn).toBe(2);
    c.apply('SUMMON'); // interrupted → listening: a fresh capture
    expect(c.turn).toBe(3);
    c.apply('CANCEL');
    expect(c.turn).toBe(4);
    expect(c.current).toBe('idle');
  });

  it('does not bump the generation for an invalid event', () => {
    const c = new DialogueController();
    c.apply('INTERRUPT'); // invalid from idle
    expect(c.turn).toBe(0);
  });
});
