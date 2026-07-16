import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Drive getPrivacy() via a stubbed settings repo (avoids better-sqlite3), stub
// the native affinity oracle, and capture broadcasts/app-events so the module
// loads without electron windows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = vi.hoisted(() => ({
  privacy: '1' as string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  windows: [] as any[],
  readable: true,
  // Per-window REAL OS affinity, as the stubbed oracle reports it.
  affinity: new Map<unknown, number | null>(),
}));
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
vi.mock('../security/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./displayAffinity', () => ({
  WDA_NONE: 0x0,
  WDA_EXCLUDEFROMCAPTURE: 0x11,
  affinityReadable: () => state.readable,
  readWindowAffinity: (w: unknown) => state.affinity.get(w) ?? 0x11,
}));

import {
  protectWindow,
  applyPrivacyToWindow,
  startProtectionObserver,
  stopProtectionObserver,
  getProtectionObserverStats,
} from './privacy';

/** A fake BrowserWindow that records setContentProtection calls and lets tests
 *  fire lifecycle events. */
function fakeWindow(title = 'win') {
  const handlers = new Map<string, (() => void)[]>();
  const calls: boolean[] = [];
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    getTitle: () => title,
    setContentProtection: (v: boolean) => calls.push(v),
    on(ev: string, fn: () => void) {
      const l = handlers.get(ev) ?? [];
      l.push(fn);
      handlers.set(ev, l);
      return this;
    },
    fire(ev: string) {
      for (const fn of handlers.get(ev) ?? []) fn();
    },
    calls,
    handlers,
  };
}

beforeEach(() => {
  state.privacy = '1';
  state.windows = [];
  state.readable = true;
  state.affinity = new Map();
  process.env.BRAINCUE_OBSERVER_MS = '50'; // pin the tick so tests don't depend on the default
  vi.useFakeTimers();
});
afterEach(() => {
  stopProtectionObserver();
  delete process.env.BRAINCUE_OBSERVER_MS;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('protectWindow', () => {
  it('applies protection exactly once at creation — set-once, no cascades, no timers', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectWindow(w as any);
    expect(w.calls).toEqual([true]);
    // NOTHING may be scheduled or event-driven beyond 'show': blind re-asserts
    // were themselves the one-frame flicker in active WGC captures.
    vi.advanceTimersByTime(5000);
    expect(w.calls).toEqual([true]);
    expect([...w.handlers.keys()]).toEqual(['show']);
  });

  it('re-applies on show (hide/show wipes the affinity; a hidden window is in no capture, so this cannot flash)', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectWindow(w as any);
    w.fire('show');
    expect(w.calls).toEqual([true, true]);
  });

  it('applies the CURRENT state — a window shown while Privacy Mode is off stays capturable', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectWindow(w as any);
    state.privacy = '0'; // user turned Privacy Mode off
    w.fire('show');
    expect(w.calls[w.calls.length - 1]).toBe(false);
  });

  it('applyPrivacyToWindow reflects the stored setting', () => {
    const w = fakeWindow();
    state.privacy = '0';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyPrivacyToWindow(w as any);
    expect(w.calls).toEqual([false]);
  });
});

describe.runIf(process.platform === 'win32')('protection observer', () => {
  it('makes ZERO setContentProtection calls while every window is genuinely excluded (the no-flicker property)', () => {
    const a = fakeWindow('a');
    const b = fakeWindow('b');
    state.windows = [a, b];
    startProtectionObserver();
    vi.advanceTimersByTime(50 * 20); // 1s of ticks, all healthy (default 0x11)
    expect(a.calls.length).toBe(0);
    expect(b.calls.length).toBe(0);
  });

  it('re-protects ONLY a window whose OS affinity was actually wiped, and counts the breach', () => {
    const wiped = fakeWindow('wiped');
    const healthy = fakeWindow('healthy');
    state.windows = [wiped, healthy];
    const before = getProtectionObserverStats().breaches;
    startProtectionObserver();
    state.affinity.set(wiped, 0x0); // the OS made it capturable behind our back
    vi.advanceTimersByTime(50);
    expect(wiped.calls).toEqual([true]);
    expect(healthy.calls.length).toBe(0);
    expect(getProtectionObserverStats().breaches).toBe(before + 1);
    // once the oracle reads excluded again, no further calls
    state.affinity.set(wiped, 0x11);
    vi.advanceTimersByTime(50 * 10);
    expect(wiped.calls).toEqual([true]);
  });

  it('never fights the user: with Privacy Mode OFF a capturable window is left alone', () => {
    const w = fakeWindow();
    state.windows = [w];
    state.privacy = '0';
    state.affinity.set(w, 0x0);
    startProtectionObserver();
    vi.advanceTimersByTime(50 * 5);
    expect(w.calls.length).toBe(0);
  });

  it('stops on stopProtectionObserver', () => {
    const w = fakeWindow();
    state.windows = [w];
    startProtectionObserver();
    stopProtectionObserver();
    state.affinity.set(w, 0x0);
    vi.advanceTimersByTime(50 * 10);
    expect(w.calls.length).toBe(0);
  });

  it('does not start without the affinity oracle (falls back to set-once; blind healing is elsewhere)', () => {
    const w = fakeWindow();
    state.windows = [w];
    state.readable = false;
    state.affinity.set(w, 0x0);
    startProtectionObserver();
    vi.advanceTimersByTime(50 * 10);
    expect(w.calls.length).toBe(0);
  });
});
