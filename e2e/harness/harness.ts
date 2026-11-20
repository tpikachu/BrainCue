import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Renderer harness (M5 race cases, M6 renderer checks): the REAL components,
 * bundled from source with esbuild, in the project's own Electron with ONE
 * HIDDEN window (harness/main.cjs — no app code, no database, no audio, no
 * network, nothing on screen, no browser download). Only the edges are fake:
 * the preload bridge (`window.api`), whose every call is RECORDED and whose
 * replies a test can script, hold or fail; and the live-session store's
 * startNew/resumeExisting, which record what they were asked to start.
 *
 * `HARNESS_ROOT` bundles from another checkout (a worktree of an earlier
 * commit) — how the "before" runs and screenshots are made with the same
 * fake and the same steps.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin = require('electron') as unknown as string;
const REPO = process.cwd();
export const ROOT = resolve(process.env.HARNESS_ROOT || REPO);
const PORT = Number(process.env.HARNESS_CDP_PORT || 9339);

export type Fixture = Record<string, unknown>;

/** The fake preload bridge, installed before the bundle runs on every load.
 *  Self-contained: it is serialized into the page. */
export function installFake(fx: any) {
  const w = window as any;
  w.__fixture = fx;
  const held = new Set<string>();
  const pending = new Map<string, (fail: boolean) => void>();
  const deferred = new Map<string, (v: unknown) => void>();
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const fake = {
    /** Every bridge call, in order: "ns.method". */
    calls: [] as string[],
    args: [] as { path: string; args: unknown[] }[],
    starts: [] as (string | null)[],
    resumes: [] as string[],
    gets: [] as string[],
    /** Scripted replies by path: a value, { throw: message }, { hold: true }
     *  (never answers), { defer: id } (answers when settle(id, value) is
     *  called — out-of-order replies), or a queue (array). */
    replies: {} as Record<string, unknown>,
    settle: (id: string, value: unknown) => {
      const r = deferred.get(id);
      deferred.delete(id);
      r?.(value);
    },
    /** Deferred replies requested and not yet settled. */
    deferredIds: () => [...deferred.keys()],
    hold: (id: string) => held.add(id),
    release: (id: string, fail = false) => {
      const p = pending.get(id);
      pending.delete(id);
      held.delete(id);
      p?.(fail);
    },
    emit: (event: string, payload: unknown) => (listeners[event] ?? []).forEach((cb) => cb(payload)),
    listening: (event: string) => (listeners[event] ?? []).length,
    /** Capture requests the page made — every one refused, never a device. */
    media: [] as string[],
  };
  w.__fake = fake;
  // The page never reaches a real microphone, camera or screen: requests are
  // refused here (and by the harness main's permission handler behind this).
  const refuse = (api: string) => () => {
    fake.media.push(api);
    return Promise.reject(new DOMException('refused by the renderer harness', 'NotAllowedError'));
  };
  // The harness origin (http://harness.local) is not a secure context, so
  // Chromium exposes no mediaDevices at all; a fake one makes a component's
  // capture call observable (and refused) instead of a silent TypeError.
  const fakeDevices = {
    getUserMedia: refuse('getUserMedia'),
    getDisplayMedia: refuse('getDisplayMedia'),
    enumerateDevices: () => Promise.resolve([]),
    addEventListener() {},
    removeEventListener() {},
  };
  if (navigator.mediaDevices) {
    for (const [k, v] of Object.entries(fakeDevices)) Object.defineProperty(navigator.mediaDevices, k, { value: v });
  } else {
    Object.defineProperty(navigator, 'mediaDevices', { value: fakeDevices, configurable: true });
  }
  const ok = <T,>(v: T) => Promise.resolve(v);
  const settings = fx.settings ?? {
    stt: { engine: 'local', localModelId: 'x' },
    audio: { micDeviceId: null },
    companionPrefs: null,
    providerKeys: {},
    sttReady: true,
    memoryEnabled: false,
    sessionArchiveEnabled: true,
  };
  const impl: Record<string, (...a: any[]) => Promise<unknown>> = {
    'settings.get': () => ok(settings),
    'settings.readiness': () => ok(fx.readiness),
    'settings.set': () => ok(settings),
    'privacy.get': () => ok({ enabled: true, supported: true }),
    'session.list': (pid: string) => ok(fx.sessions?.[pid] ?? []),
    'session.page': (pid: string, q: string, limit: number, offset: number) => {
      const all = (fx.history?.[pid] ?? []).filter((s: any) => !q || `${s.jobTitle ?? ''} ${s.jobCompany ?? ''}`.toLowerCase().includes(q.toLowerCase()));
      return ok({ items: all.slice(offset, offset + limit), total: all.length });
    },
    'session.get': (id: string) => (fx.details?.[id] ? ok(fx.details[id]) : Promise.reject(new Error('Session not found'))),
    'jobs.get': (id: string) => {
      fake.gets.push(id);
      const r = (fx.roles ?? []).find((x: any) => x.id === id) ?? null;
      if (!held.has(id)) return ok(r);
      return new Promise((res, rej) => pending.set(id, (fail) => (fail ? rej(new Error('lookup failed')) : res(r))));
    },
    'jobs.page': (pid: string, q: string, limit: number, offset: number, activity?: string) => {
      const items = (fx.roles ?? []).filter((r: any) => r.profileId === pid && (!activity || r.kind === activity) && (!q || r.title.includes(q)));
      return ok({ items: items.slice(offset, offset + limit), total: items.length });
    },
  };
  const call = (path: string, args: unknown[]): unknown => {
    fake.calls.push(path);
    fake.args.push({ path, args });
    if (path in fake.replies) {
      let r = fake.replies[path];
      if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
      if (r && typeof r === 'object' && 'throw' in (r as any)) return Promise.reject(new Error((r as any).throw));
      if (r && typeof r === 'object' && 'hold' in (r as any)) return new Promise(() => {});
      if (r && typeof r === 'object' && 'defer' in (r as any)) return new Promise((res) => deferred.set((r as any).defer, res));
      return ok(r);
    }
    if (impl[path]) return impl[path](...args);
    return ok(null);
  };
  const events = new Proxy(
    {},
    {
      get: (_t, k: string) => (cb: (p: unknown) => void) => {
        (listeners[k] ??= []).push(cb);
        return () => {
          listeners[k] = (listeners[k] ?? []).filter((x) => x !== cb);
        };
      },
    },
  );
  w.api = new Proxy(
    {},
    {
      get: (_t, ns: string) =>
        ns === 'events'
          ? events
          : new Proxy({}, { get: (_t2, m: string) => (...args: unknown[]) => call(`${ns}.${m}`, args) }),
    },
  );
}

/** The app's built stylesheet (Tailwind), when present — screenshots look
 *  like the app; behaviour does not depend on it. */
function builtCss(): string {
  const dir = join(ROOT, 'out', 'renderer', 'assets');
  if (!existsSync(dir)) return '';
  const css = readdirSync(dir).find((f) => f.endsWith('.css'));
  return css ? readFileSync(join(dir, css), 'utf8') : '';
}

export interface Harness {
  page: Page;
  /** Load a fresh page for this view: the fake and the bundle start over. */
  load: (view: string) => Promise<Page>;
  close: () => Promise<void>;
}

export async function launchHarness(fixture: Fixture): Promise<Harness> {
  const out = await build({
    entryPoints: [resolve(REPO, 'e2e/harness/entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    absWorkingDir: ROOT,
    nodePaths: [join(REPO, 'node_modules')],
    alias: {
      '@shared': resolve(ROOT, 'src/shared'),
      '@renderer': resolve(ROOT, 'src/renderer'),
      '@app': resolve(ROOT, 'src/renderer'),
    },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.md': 'text' },
    logLevel: 'silent',
  });
  const js = out.outputFiles[0].text.split('</script').join('<\\/script');
  const css = builtCss().split('</style').join('<\\/style');
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-neutral-950 text-neutral-100"><div id="root"></div><script>${js}</script></body></html>`;

  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_CDP_PORT: String(PORT), HARNESS_USER_DATA: mkdtempSync(join(tmpdir(), 'bc-harness-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc: ChildProcess = spawn(electronBin, [resolve(REPO, 'e2e/harness/main.cjs')], { env, stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('harness Electron never opened its CDP port');
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page: Page | undefined;
  for (let i = 0; i < 50 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error('harness window not found');
  await page.addInitScript(installFake, fixture);
  await page.route('http://harness.local/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const p = page;
  // The window is hidden and never focused by the OS; without this the page
  // alternately has and lacks focus across navigations, and key presses go
  // nowhere. Focus emulation makes it behave as a focused page (as headless
  // Chromium does), so keyboard checks are real keyboard checks.
  const cdp = await p.context().newCDPSession(p);
  const focus = () => cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await focus();
  return {
    page: p,
    load: async (view: string) => {
      // In the hidden window an occasional fresh document receives NO input
      // from CDP (keys or mouse) although scripts run — so each load proves
      // input arrives (one Shift press, seen by a capture listener) and loads
      // again if not. Tests then drive a document that really takes input.
      for (let attempt = 0; ; attempt++) {
        await p.goto(`http://harness.local/?view=${view}`);
        await focus();
        await p.waitForFunction(() => !!(window as any).__harness);
        await p.evaluate(() => {
          (window as any).__inputOk = false;
          window.addEventListener('keydown', () => ((window as any).__inputOk = true), { capture: true, once: true });
        });
        await p.keyboard.press('Shift');
        if (await p.evaluate(() => (window as any).__inputOk)) return p;
        if (attempt >= 4) throw new Error('harness page never received input');
      }
    },
    close: async () => {
      await browser.close().catch(() => {});
      const exited = new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)));
      if (proc.pid) {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      }
      // The next spec file launches on the same port: wait until this one is
      // gone, or it would attach to a window that is about to die.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      for (let i = 0; i < 50; i++) {
        try {
          await fetch(`http://127.0.0.1:${PORT}/json/version`);
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

/** Bridge calls the page made, in order. */
export const calls = (page: Page) => page.evaluate(() => (window as any).__fake.calls as string[]);
