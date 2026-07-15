import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Drive getPrivacy() via a stubbed settings repo (avoids better-sqlite3), and
// capture broadcasts/app-events so the module loads without electron windows.
const state = vi.hoisted(() => ({ privacy: '1' as string | null, windows: [] as unknown[] }));
vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { privacyMode: 'privacy_mode' },
  settingsRepo: {
    get: (k: string) => (k === 'privacy_mode' ? state.privacy : null),
    set: (_k: string, v: string) => {
      state.privacy = v;
    },
  },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => state.windows },
  dialog: {},
}));
vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('@shared/ipc', () => ({ EVENTS: { privacyChanged: 'privacy:changed' } }));
vi.mock('../../appEvents', () => ({ appEvents: { emit: vi.fn() }, APP_EVENT: { privacyChanged: 'x' } }));

import { keepContentProtected, applyPrivacyToWindow, startContentProtectionWatchdog } from './privacy';

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
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('keepContentProtected', () => {
  it('applies protection immediately and re-asserts on every drag-relevant event', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.calls).toEqual([true]); // applied up front

    // A drag fires many 'move' events; each must re-assert exclusion.
    w.fire('move');
    w.fire('move');
    w.fire('resize');
    w.fire('restore');
    w.fire('focus');
    w.fire('show');
    expect(w.calls.filter((c) => c === true).length).toBe(7); // 1 initial + 6 events
  });

  it('re-asserts again shortly AFTER an event (double-tap): the DWM drop caused by the same input can land after the synchronous re-call', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    w.fire('focus');
    expect(w.calls.length).toBe(2); // initial + synchronous
    vi.advanceTimersByTime(400);
    expect(w.calls.length).toBe(9); // + the 4/10/20/40/80/160/300ms deferred taps
    expect(w.calls.every((c) => c === true)).toBe(true);
  });

  it('collapses deferred taps across an event burst (a drag must not pile up timers)', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    for (let i = 0; i < 10; i++) w.fire('move'); // burst: 10 immediate re-asserts
    vi.advanceTimersByTime(400);
    // 1 initial + 10 immediate + only ONE cascade of 7 trailing taps
    expect(w.calls.length).toBe(18);
  });

  it('re-asserts the CURRENT state — clears protection when Privacy Mode is off', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.calls).toEqual([true]);
    state.privacy = '0'; // user turned Privacy Mode off
    w.fire('move'); // a later move must not re-hide against the user's choice
    expect(w.calls[w.calls.length - 1]).toBe(false);
  });

  it('subscribes to move + resize (the Windows drag/resize drop points)', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    expect(w.handlers.has('move')).toBe(true);
    expect(w.handlers.has('resize')).toBe(true);
  });

  it('re-asserts on webContents mouseDown — a click on an ALREADY-ACTIVE window fires no activation message but can still drop the exclusion', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepContentProtected(w as any);
    const before = w.calls.length;
    w.fireInput('mouseMove'); // moves are noise — must NOT re-assert
    expect(w.calls.length).toBe(before);
    w.fireInput('mouseDown');
    expect(w.calls.length).toBe(before + 1);
    expect(w.calls[w.calls.length - 1]).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    're-asserts inside the native messages for activation, child-window clicks, and window-pos/z-order changes',
    () => {
      const w = fakeWindow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keepContentProtected(w as any);
      // WM_MOUSEACTIVATE (click on inactive window), WM_PARENTNOTIFY (click on
      // active window, via child HWND), WM_WINDOWPOSCHANGED (move/size/Z-ORDER —
      // a pure z-order change fires NO Electron event but drops the exclusion).
      for (const msg of [0x0021, 0x0210, 0x0047]) {
        expect(w.msgHooks.has(msg)).toBe(true);
        const before = w.calls.length;
        w.fireMsg(msg);
        expect(w.calls.length).toBe(before + 1);
        expect(w.calls[w.calls.length - 1]).toBe(true);
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

  it('watchdog re-asserts periodically while Privacy Mode is ON, never while OFF (backstop for spontaneous DWM drops)', () => {
    const w = fakeWindow();
    state.windows = [w];
    startContentProtectionWatchdog(50);
    vi.advanceTimersByTime(220);
    const whileOn = w.calls.length;
    expect(whileOn).toBeGreaterThanOrEqual(4); // ~every 50ms
    expect(w.calls.every((c) => c === true)).toBe(true);
    state.privacy = '0'; // user turned Privacy Mode off — the timer must not re-hide
    vi.advanceTimersByTime(300);
    expect(w.calls.length).toBe(whileOn);
    state.windows = [];
  });
});
