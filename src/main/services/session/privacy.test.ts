import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Drive getPrivacy() via a stubbed settings repo (avoids better-sqlite3), stub
// the native affinity helpers, and replace the off-thread AffinityObserver with a
// recorder so we can assert privacy.ts wires it correctly (the worker's own
// detect-and-heal loop is covered by affinityWorker.test.ts + drive.js).
const state = vi.hoisted(() => ({ privacy: '1' as string | null, windows: [] as unknown[] }));
const obs = vi.hoisted(() => ({
  start: [] as boolean[],
  stop: 0,
  watch: [] as string[],
  unwatch: [] as string[],
  privacy: [] as boolean[],
  stats: { breaches: 0, lastBreachAt: 0 },
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
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// requestPrivacy now confirms via the in-window primitive; stub it so this unit
// doesn't pull in the window/ipc graph (its own logic is in confirm.test.ts).
vi.mock('../ui/confirm', () => ({ confirmInWindow: vi.fn().mockResolvedValue(false) }));
vi.mock('./displayAffinity', () => ({
  WDA_NONE: 0x0,
  WDA_EXCLUDEFROMCAPTURE: 0x11,
  // privacy.ts only needs hwndOf; each fake window carries its own id.
  hwndOf: (w: { __hwnd?: string }) => BigInt(w?.__hwnd ?? '0'),
}));
vi.mock('./affinityWorker', () => ({
  AffinityObserver: class {
    start(on: boolean) {
      obs.start.push(on);
    }
    stop() {
      obs.stop++;
    }
    watch(h: bigint) {
      obs.watch.push(h.toString());
    }
    unwatch(h: bigint) {
      obs.unwatch.push(h.toString());
    }
    setPrivacy(on: boolean) {
      obs.privacy.push(on);
    }
    getStats() {
      return obs.stats;
    }
  },
}));

import {
  protectWindow,
  applyPrivacyToWindow,
  startProtectionObserver,
  stopProtectionObserver,
  getProtectionObserverStats,
  setPrivacy,
} from './privacy';

/** A fake BrowserWindow that records setContentProtection calls and lets tests
 *  fire lifecycle events; `__hwnd` is the id the mocked hwndOf() returns. */
function fakeWindow(hwnd = '111') {
  const handlers = new Map<string, (() => void)[]>();
  const calls: boolean[] = [];
  return {
    __hwnd: hwnd,
    isDestroyed: () => false,
    isVisible: () => true,
    getTitle: () => 'win',
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
  obs.start = [];
  obs.stop = 0;
  obs.watch = [];
  obs.unwatch = [];
  obs.privacy = [];
  obs.stats = { breaches: 3, lastBreachAt: 42 };
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('protectWindow', () => {
  it('applies protection exactly once at creation — set-once, no cascades, no timers', () => {
    const w = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectWindow(w as any);
    expect(w.calls).toEqual([true]);
    // NOTHING may be scheduled or event-driven beyond 'show'/'closed': blind
    // re-asserts were themselves the one-frame flicker in active WGC captures.
    vi.advanceTimersByTime(5000);
    expect(w.calls).toEqual([true]);
    expect([...w.handlers.keys()]).toEqual(['show', 'closed']);
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

  it('registers the window with the observer on creation and unregisters it on close', () => {
    const w = fakeWindow('909');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectWindow(w as any);
    expect(obs.watch).toEqual(['909']);
    expect(obs.unwatch).toEqual([]);
    w.fire('closed');
    expect(obs.unwatch).toEqual(['909']);
  });

  it('applyPrivacyToWindow reflects the stored setting', () => {
    const w = fakeWindow();
    state.privacy = '0';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyPrivacyToWindow(w as any);
    expect(w.calls).toEqual([false]);
  });
});

describe('protection observer wiring', () => {
  it('starts the observer with the current Privacy Mode state', () => {
    startProtectionObserver();
    expect(obs.start).toEqual([true]);
  });

  it('starts disabled when Privacy Mode is off (never fights the user)', () => {
    state.privacy = '0';
    startProtectionObserver();
    expect(obs.start).toEqual([false]);
  });

  it('stops the observer on stopProtectionObserver', () => {
    stopProtectionObserver();
    expect(obs.stop).toBe(1);
  });

  it('mirrors a Privacy Mode toggle to the observer', () => {
    setPrivacy(false);
    setPrivacy(true);
    expect(obs.privacy).toEqual([false, true]);
  });

  it('exposes the observer breach stats', () => {
    expect(getProtectionObserverStats()).toEqual({ breaches: 3, lastBreachAt: 42 });
  });
});
