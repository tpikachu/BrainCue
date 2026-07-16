import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Drive getPrivacy() via a stubbed settings repo (avoids better-sqlite3), and
// capture broadcasts/app-events so the module loads without electron windows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = vi.hoisted(() => ({ privacy: '1' as string | null, windows: [] as any[] }));
vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { privacyMode: 'privacy_mode' },
  settingsRepo: {
    get: (k: string) => (k === 'privacy_mode' ? state.privacy : null),
    set: (_k: string, v: string) => {
      state.privacy = v;
    },
  },
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => state.windows }, dialog: {} }));
vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('@shared/ipc', () => ({ EVENTS: { privacyChanged: 'privacy:changed' } }));
vi.mock('../../appEvents', () => ({ appEvents: { emit: vi.fn() }, APP_EVENT: { privacyChanged: 'x' } }));

import { keepContentProtected, applyPrivacyToWindow, startCaptureShield, stopCaptureShield } from './privacy';

/** A fake BrowserWindow that records setContentProtection calls and lets tests
 *  fire lifecycle events, native window messages, and webContents input events. */
function fakeWindow() {
  const handlers = new Map<string, (() => void)[]>();
  const msgHooks = new Map<number, (() => void)[]>();
  const inputHandlers: ((e: unknown, input: { type: string }) => void)[] = [];
  const calls: boolean[] = [];
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    setContentProtection: (v: boolean) => calls.push(v),
    webContents: {
      on(ev: string, fn: (e: unknown, input: { type: string }) => void) {
        if (ev === 'input-event') inputHandlers.push(fn);
      },
    },
    on(ev: string, fn: () => void) {
      const l = handlers.get(ev) ?? [];
      l.push(fn);
      handlers.set(ev, l);
      return this;
    },
    hookWindowMessage(msg: number, fn: () => void) {
      const l = msgHooks.get(msg) ?? [];
      l.push(fn);
      msgHooks.set(msg, l);
    },
    fire(ev: string) {
      for (const fn of handlers.get(ev) ?? []) fn();
    },
    fireMsg(msg: number) {
      for (const fn of msgHooks.get(msg) ?? []) fn();
    },
    fireInput(type: string) {
      for (const fn of inputHandlers) fn({}, { type });
    },
    calls,
    handlers,
    msgHooks,
  };
}

beforeEach(() => {
  state.privacy = '1';
  state.windows = [];
  vi.useFakeTimers();
});
afterEach(() => {
  stopCaptureShield();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('keepContentProtected', () => {
  it('applies protection once up front, then re-asserts via a deferred cascade on a drop-trigger event (no synchronous re-call per message — keeps re-call count, hence capture flicker, low)', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.calls).toEqual([true]); // applied up front, nothing scheduled yet

    w.fire('focus');
    // NOTHING synchronous — the cascade is fully deferred (first tap at next tick)
    expect(w.calls.length).toBe(1);
    vi.advanceTimersByTime(400);
    expect(w.calls.length).toBe(5); // 1 initial + the 0/16/48/120ms cascade
    expect(w.calls.every((c) => c === true)).toBe(true);
  });

  it('coalesces the cascade across an event burst — one click (or a drag) is a handful of re-calls, not dozens', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    for (let i = 0; i < 10; i++) w.fire('move'); // burst of 10 signals
    expect(w.calls.length).toBe(1); // still nothing synchronous
    vi.advanceTimersByTime(400);
    // 1 initial + only ONE coalesced cascade of 4 taps (not 10×4)
    expect(w.calls.length).toBe(5);
  });

  it('re-asserts the CURRENT state — clears protection when Privacy Mode is off', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.calls).toEqual([true]);
    state.privacy = '0'; // user turned Privacy Mode off
    w.fire('move'); // a later move must not re-hide against the user's choice
    vi.advanceTimersByTime(200); // let the deferred cascade run
    expect(w.calls[w.calls.length - 1]).toBe(false);
  });

  it('subscribes to move + resize (the Windows drag/resize drop points)', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.handlers.has('move')).toBe(true);
    expect(w.handlers.has('resize')).toBe(true);
  });

  it('schedules a re-assert on webContents mouseDown — a click on an ALREADY-ACTIVE window fires no activation message but can still drop the exclusion', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    w.fireInput('mouseMove'); // moves are noise — must NOT schedule a cascade
    vi.advanceTimersByTime(400);
    expect(w.calls.length).toBe(1); // still just the initial
    w.fireInput('mouseDown');
    vi.advanceTimersByTime(400);
    expect(w.calls.length).toBe(5); // initial + 0/16/48/120ms cascade
    expect(w.calls.every((c) => c === true)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'hooks the native messages for activation, child-window clicks, and window-pos/z-order changes, and each schedules a re-assert',
    () => {
      const w = fakeWindow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keepContentProtected(w as any);
      // WM_MOUSEACTIVATE (click on inactive window), WM_PARENTNOTIFY (click on
      // active window, via child HWND), WM_WINDOWPOSCHANGED (move/size/Z-ORDER —
      // a pure z-order change fires NO Electron event but drops the exclusion).
      for (const msg of [0x0021, 0x0210, 0x0047]) {
        expect(w.msgHooks.has(msg)).toBe(true);
        w.calls.length = 0;
        w.fireMsg(msg);
        expect(w.calls.length).toBe(0); // deferred, not synchronous
        vi.advanceTimersByTime(200);
        expect(w.calls.length).toBe(4); // the 0/16/48/120ms cascade
        expect(w.calls.every((c) => c === true)).toBe(true);
      }
    },
  );

  it('applyPrivacyToWindow reflects the stored setting', () => {
    const w = fakeWindow();
    state.privacy = '0';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyPrivacyToWindow(w as any);
    expect(w.calls).toEqual([false]);
  });
});

describe('capture shield', () => {
  it('re-asserts protection on every window on an interval while running, and stops on stopCaptureShield', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    state.windows = [a, b];
    startCaptureShield();
    expect(a.calls.length).toBe(0); // nothing synchronous — first re-assert is on the first tick
    vi.advanceTimersByTime(80 * 5); // ~5 ticks at the default 80ms cadence
    expect(a.calls.length).toBeGreaterThanOrEqual(4);
    expect(b.calls.length).toBe(a.calls.length); // every window re-asserted together
    expect(a.calls.every((c) => c === true)).toBe(true); // Privacy Mode on -> protect
    const after = a.calls.length;
    stopCaptureShield();
    vi.advanceTimersByTime(80 * 5);
    expect(a.calls.length).toBe(after); // no more re-asserts once stopped
  });

  it('re-asserts the CURRENT privacy state — clears protection when Privacy Mode is off', () => {
    const w = fakeWindow();
    state.windows = [w];
    state.privacy = '0';
    startCaptureShield();
    vi.advanceTimersByTime(80);
    expect(w.calls[w.calls.length - 1]).toBe(false);
    stopCaptureShield();
  });
});
