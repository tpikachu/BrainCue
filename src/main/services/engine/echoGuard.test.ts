import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECHO_HOLD_MS, ECHO_WINDOW_MS, EchoGuard, sameWords, turnWords } from './echoGuard';

/**
 * On laptop speakers the microphone hears the call, so every remote turn
 * comes back a second time as the user's "own" words. The guard holds own
 * turns briefly and drops the ones the call already said.
 */
describe('sameWords', () => {
  const w = turnWords;
  it('ignores case and punctuation', () => {
    expect(sameWords(w("Fine. Let's decide next week"), w("fine let's decide next week"))).toBe(true);
  });
  it('tolerates a clipped or slightly mis-heard copy of a longer turn', () => {
    expect(
      sameWords(w('We have until the end of the month to confirm'), w('have until the end of the month to confirm.')),
    ).toBe(true);
    expect(sameWords(w('Marketing put it back, I think'), w('Marketing put it back, I thing'))).toBe(true);
  });
  it('does not match different sentences that share a few words', () => {
    expect(sameWords(w('What is our budget for the campaign'), w('What is the timeline for the launch'))).toBe(false);
  });
  it('short turns must match exactly — "okay" is not an echo of "okay, go on"', () => {
    expect(sameWords(w('Okay.'), w('okay'))).toBe(true);
    expect(sameWords(w('Okay'), w('Okay, go on'))).toBe(false);
    expect(sameWords(w('Thank you'), w('thank you'))).toBe(true);
  });
});

describe('EchoGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits an own turn after the hold when the call never said it', () => {
    const g = new EchoGuard();
    const commit = vi.fn();
    expect(g.ownTurn('I led the migration last year.', commit)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ECHO_HOLD_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(g.held).toBe(0);
  });

  it('drops an own turn the call just said (call first, mic second)', () => {
    const g = new EchoGuard();
    g.remoteTurn('I thought we had dropped that');
    const commit = vi.fn();
    expect(g.ownTurn('I thought we had dropped that', commit)).toBe(false);
    vi.advanceTimersByTime(ECHO_HOLD_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('drops a held own turn when the call says the same words a moment later (mic first)', () => {
    const g = new EchoGuard();
    const commit = vi.fn();
    g.ownTurn('Marketing put it back.', commit);
    vi.advanceTimersByTime(400);
    g.remoteTurn('Marketing put it back.');
    vi.advanceTimersByTime(ECHO_HOLD_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(g.held).toBe(0);
  });

  it("keeps the user's genuine reply while dropping only the echo", () => {
    const g = new EchoGuard();
    const echo = vi.fn();
    const reply = vi.fn();
    g.remoteTurn('Have you had a chance to look at the pricing draft?');
    g.ownTurn('Have you had a chance to look at the pricing draft', echo);
    g.ownTurn('Yes, I went through it this morning.', reply);
    vi.advanceTimersByTime(ECHO_HOLD_MS);
    expect(echo).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('forgets remote turns after the window, so the user can repeat the call later', () => {
    const g = new EchoGuard();
    g.remoteTurn('Let us decide next week.');
    vi.advanceTimersByTime(ECHO_WINDOW_MS + 1);
    const commit = vi.fn();
    expect(g.ownTurn('Let us decide next week.', commit)).toBe(true);
    vi.advanceTimersByTime(ECHO_HOLD_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flush commits everything held, in order, without waiting', () => {
    const g = new EchoGuard();
    const order: string[] = [];
    g.ownTurn('first thing I said', () => order.push('first'));
    g.ownTurn('second thing I said', () => order.push('second'));
    g.flush();
    expect(order).toEqual(['first', 'second']);
    expect(g.held).toBe(0);
    vi.advanceTimersByTime(ECHO_HOLD_MS);
    expect(order).toHaveLength(2);
  });
});
