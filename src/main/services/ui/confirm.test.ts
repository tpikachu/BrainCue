import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// confirmInWindow shows an in-window modal (NOT a native dialog) and awaits the
// renderer's reply. We stub the windows, the `handle` registrar (to capture the
// reply handler), and electron's dialog (native fallback), then assert: host
// selection, the reply→resolve round-trip, timeout, host-close, and fallback.
const state = vi.hoisted(() => ({
  main: null as FakeWin | null,
  overlay: null as FakeWin | null,
  focused: null as FakeWin | null,
  msgResponse: 0,
  handler: null as null | ((arg: { id: string; ok: boolean }) => unknown),
  handlerChannel: '' as string,
}));

interface FakeWin {
  _sent: { ch: string; payload: { id: string } & Record<string, unknown> }[];
  show: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  isVisible(): boolean;
  once(ev: string, fn: () => void): FakeWin;
  off(ev: string, fn: () => void): FakeWin;
  fireClosed(): void;
  webContents: { send(ch: string, payload: unknown): void };
}

function fakeWin({ visible = true } = {}): FakeWin {
  const closed: (() => void)[] = [];
  const sent: FakeWin['_sent'] = [];
  const w: FakeWin = {
    _sent: sent,
    show: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => visible,
    once(ev, fn) {
      if (ev === 'closed') closed.push(fn);
      return w;
    },
    off(ev, fn) {
      if (ev === 'closed') {
        const i = closed.indexOf(fn);
        if (i >= 0) closed.splice(i, 1);
      }
      return w;
    },
    fireClosed() {
      for (const fn of [...closed]) fn();
    },
    webContents: {
      send: (ch, payload) => sent.push({ ch, payload: payload as FakeWin['_sent'][0]['payload'] }),
    },
  };
  return w;
}

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => state.focused },
  dialog: { showMessageBox: vi.fn(async () => ({ response: state.msgResponse })) },
}));
vi.mock('../../windows/mainWindow', () => ({ getMainWindow: () => state.main }));
vi.mock('../../windows/overlayWindow', () => ({ getOverlayWindow: () => state.overlay }));
vi.mock('../../ipc/helpers', () => ({
  handle: (ch: string, _schema: unknown, fn: (a: { id: string; ok: boolean }) => unknown) => {
    state.handlerChannel = ch;
    state.handler = fn;
  },
}));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { confirmInWindow, registerConfirmIpc } from './confirm';
import { EVENTS, IPC } from '@shared/ipc';

const OPTS = {
  title: 'Turn off Privacy Mode?',
  detail: 'You will be visible.',
  confirmLabel: 'Turn off Privacy Mode',
  cancelLabel: 'Keep it on',
  tone: 'danger' as const,
};

beforeEach(() => {
  state.main = null;
  state.overlay = null;
  state.focused = null;
  state.msgResponse = 0;
  state.handler = null;
  state.handlerChannel = '';
  vi.useFakeTimers();
  registerConfirmIpc(); // capture the reply handler
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('confirmInWindow — host selection', () => {
  it('sends the request to the focused app window when it is visible', () => {
    state.main = fakeWin();
    state.overlay = fakeWin();
    state.focused = state.overlay; // user is on the Cue Card
    void confirmInWindow(OPTS);
    expect(state.overlay._sent).toHaveLength(1);
    expect(state.main._sent).toHaveLength(0);
    const p = state.overlay._sent[0];
    expect(p.ch).toBe(EVENTS.confirmRequest);
    expect(p.payload).toMatchObject({ title: OPTS.title, tone: 'danger', confirmLabel: OPTS.confirmLabel });
    expect(typeof p.payload.id).toBe('string');
  });

  it('falls back to a visible main window when nothing is focused', () => {
    state.main = fakeWin({ visible: true });
    state.overlay = fakeWin({ visible: true });
    void confirmInWindow(OPTS);
    expect(state.main._sent).toHaveLength(1);
    expect(state.overlay._sent).toHaveLength(0);
  });

  it('uses the overlay when the main window is hidden', () => {
    state.main = fakeWin({ visible: false });
    state.overlay = fakeWin({ visible: true });
    void confirmInWindow(OPTS);
    expect(state.overlay._sent).toHaveLength(1);
  });

  it('surfaces (shows) the main window when every window is hidden', () => {
    state.main = fakeWin({ visible: false });
    state.overlay = fakeWin({ visible: false });
    void confirmInWindow(OPTS);
    expect(state.main!.show).toHaveBeenCalledOnce();
    expect(state.main!._sent).toHaveLength(1);
  });
});

describe('confirmInWindow — resolution', () => {
  it('resolves TRUE when the renderer confirms', async () => {
    state.main = fakeWin();
    const p = confirmInWindow(OPTS);
    const { id } = state.main._sent[0].payload;
    state.handler!({ id, ok: true });
    await expect(p).resolves.toBe(true);
  });

  it('resolves FALSE when the renderer cancels', async () => {
    state.main = fakeWin();
    const p = confirmInWindow(OPTS);
    const { id } = state.main._sent[0].payload;
    state.handler!({ id, ok: false });
    await expect(p).resolves.toBe(false);
  });

  it('resolves FALSE on timeout (no reply)', async () => {
    state.main = fakeWin();
    const p = confirmInWindow(OPTS);
    vi.advanceTimersByTime(2 * 60_000);
    await expect(p).resolves.toBe(false);
  });

  it('resolves FALSE if the host window closes before a reply', async () => {
    state.main = fakeWin();
    const p = confirmInWindow(OPTS);
    state.main.fireClosed();
    await expect(p).resolves.toBe(false);
  });

  it('a stale reply after resolution is ignored (no throw)', async () => {
    state.main = fakeWin();
    const p = confirmInWindow(OPTS);
    const { id } = state.main._sent[0].payload;
    state.handler!({ id, ok: true });
    await p;
    expect(() => state.handler!({ id, ok: false })).not.toThrow(); // id already deleted
  });
});

describe('confirmInWindow — native fallback (no renderer window)', () => {
  it('falls back to a native dialog and returns its result', async () => {
    state.msgResponse = 0; // native "confirm"
    await expect(confirmInWindow(OPTS)).resolves.toBe(true);
    state.msgResponse = 1; // native "cancel"
    await expect(confirmInWindow(OPTS)).resolves.toBe(false);
  });
});

describe('registerConfirmIpc', () => {
  it('registers the confirm-response channel', () => {
    expect(state.handlerChannel).toBe(IPC.ui.confirmResponse);
  });
  it('returns ok for a reply to an unknown id', () => {
    expect(state.handler!({ id: 'nope', ok: true })).toEqual({ ok: true });
  });
});
