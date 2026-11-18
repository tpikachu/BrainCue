import { test as base, expect, chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The REAL StartSessionModal under controlled timing (M5 review): a role
 * lookup still in flight must never overwrite a NEWER choice.
 *
 * It runs in the project's own Electron (its Chromium) with ONE HIDDEN window
 * and no app code — harness/main.cjs: nothing appears on screen, no database,
 * no audio, no network, and no browser download. The modal's bundle runs
 * against a fake preload bridge whose `jobs.get` replies the test holds and
 * releases, and a stubbed `startNew` that records the job id Start submits.
 * Each case asserts that submitted id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin = require('electron') as unknown as string;
const ROOT = process.cwd();
const PORT = Number(process.env.HARNESS_CDP_PORT || 9339);

const parsedResume = { skills: ['TS'], projects: [], workHistory: [], metrics: [], education: [], certifications: [], techStack: [], leadership: [] };
const parsedJd = { requirements: ['x'], responsibilities: [], keywords: [], focusAreas: [] };
const role = (id: string, profileId: string) => ({
  id,
  profileId,
  kind: 'job',
  title: `Role ${id}`,
  company: 'Acme',
  jdText: 'JD',
  parsedJd,
  updatedAt: 1,
});
const FIXTURE = {
  profiles: [
    { id: 'pA', name: 'Alex', parsedResume, resumeText: 'x' },
    { id: 'pB', name: 'Sam', parsedResume, resumeText: 'x' },
  ],
  roles: [role('A', 'pA'), role('B', 'pA'), role('C', 'pB'), role('D', 'pA')],
  /** Alex last interviewed for D — so with no role handed in, D is the default. */
  sessions: { pA: [{ id: 's1', kind: 'live', mode: 'interview', activity: 'job', jobId: 'D' }] } as Record<string, unknown[]>,
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'Anthropic · Claude Sonnet 5.5 — why' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
    features: { parsing: { ready: true }, mock: { ready: true }, sparring: { ready: true }, tailoring: { ready: true } },
  },
};

/** The fake preload bridge, installed before the bundle runs on every load. */
function installFake(fx: typeof FIXTURE) {
  const w = window as any;
  w.__fixture = fx;
  const held = new Set<string>();
  const pending = new Map<string, (fail: boolean) => void>();
  w.__fake = {
    starts: [] as (string | null)[],
    gets: [] as string[],
    hold: (id: string) => held.add(id),
    release: (id: string, fail = false) => {
      const p = pending.get(id);
      pending.delete(id);
      held.delete(id);
      p?.(fail);
    },
  };
  const ok = <T,>(v: T) => Promise.resolve(v);
  const settings = { stt: { engine: 'local', localModelId: 'x' }, audio: { micDeviceId: null }, companionPrefs: null, providerKeys: {}, sttReady: true };
  const known: Record<string, unknown> = {
    events: new Proxy({}, { get: () => () => () => {} }),
    settings: { get: () => ok(settings), readiness: () => ok(fx.readiness), set: () => ok(settings) },
    session: { list: (pid: string) => ok(fx.sessions[pid] ?? []) },
    jobs: {
      get: (id: string) => {
        w.__fake.gets.push(id);
        const r = fx.roles.find((x) => x.id === id) ?? null;
        if (!held.has(id)) return ok(r);
        return new Promise((res, rej) => pending.set(id, (fail) => (fail ? rej(new Error('lookup failed')) : res(r))));
      },
      page: (pid: string, q: string, limit: number, offset: number, activity?: string) => {
        const items = fx.roles.filter((r) => r.profileId === pid && (!activity || r.kind === activity) && (!q || r.title.includes(q)));
        return ok({ items: items.slice(offset, offset + limit), total: items.length });
      },
    },
  };
  w.api = new Proxy(known, { get: (t, k: string) => t[k] ?? new Proxy({}, { get: () => () => ok(null) }) });
}

let proc: ChildProcess | undefined;
let browser: Browser | undefined;
let shared: Page | undefined;
let html = '';

base.beforeAll(async () => {
  const out = await build({
    entryPoints: [resolve(ROOT, 'e2e/harness/startModal.entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    alias: { '@shared': resolve(ROOT, 'src/shared'), '@renderer': resolve(ROOT, 'src/renderer') },
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const js = out.outputFiles[0].text.split('</script').join('<\\/script');
  html = `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>`;

  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_CDP_PORT: String(PORT), HARNESS_USER_DATA: mkdtempSync(join(tmpdir(), 'bc-harness-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(electronBin, [resolve(ROOT, 'e2e/harness/main.cjs')], { env, stdio: 'ignore' });
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
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 50 && !shared; i++) {
    shared = browser.contexts().flatMap((c) => c.pages())[0];
    if (!shared) await new Promise((r) => setTimeout(r, 100));
  }
  if (!shared) throw new Error('harness window not found');
  await shared.addInitScript(installFake, FIXTURE);
  await shared.route('http://harness.local/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
});

base.afterAll(async () => {
  await browser?.close().catch(() => {});
  if (proc?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  }
});

/** A fresh load per case: the fake and the bundle start over. */
const test = base.extend<{ hpage: Page }>({
  hpage: async ({}, use) => {
    await shared!.goto('http://harness.local/');
    await shared!.waitForFunction(() => !!(window as any).__harness);
    await use(shared!);
  },
});

const dialog = (page: Page) => page.getByRole('dialog', { name: /Start an interview/ });
const roleRow = (page: Page) => dialog(page).locator('li', { hasText: 'Role & JD' }).first();
const startBtn = (page: Page) => dialog(page).getByRole('button', { name: 'Start interview' });
const h = (page: Page, js: string) => page.evaluate(js);
/** The job ids Start submitted, in order. */
const starts = (page: Page) => page.evaluate(() => (window as any).__fake.starts as (string | null)[]);
const waitGet = (page: Page, id: string) => page.waitForFunction((x) => (window as any).__fake.gets.includes(x), id);
/** Choose an open Dropdown option. Dispatched, not a pointer click: the
 *  harness window is hidden and never focused, and the Dropdown closes on
 *  window blur — which a synthesized pointer click there can fire first. */
const pickOption = (page: Page, label: string) =>
  page.locator('ul[role="listbox"] li[role="option"] button').filter({ hasText: label }).first().dispatchEvent('click');

test('baseline: a role handed in is chosen, and Start submits it', async ({ hpage: page }) => {
  await h(page, `__harness.open('A')`);
  await expect(roleRow(page)).toContainText('Role A');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['A']);
});

test("A's lookup held, closed, reopened for B: A's late reply never replaces B", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.close()`);
  await expect(dialog(page)).toHaveCount(0);
  await h(page, `__harness.open('B')`);
  await expect(roleRow(page)).toContainText('Role B');
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});

test("A's lookup held, B chosen in the picker: A's late reply never replaces B", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await dialog(page).locator('button[aria-haspopup="listbox"]').first().click();
  await pickOption(page, 'Role B');
  await expect(roleRow(page)).toContainText('Role B');
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});

test("profile switched while A's lookup is pending: the new profile's role, never A", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.setProfile('pB')`);
  await expect(roleRow(page)).toContainText('Role C'); // Sam's only role
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role C');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['C']);
});

test("a stale lookup's failure and finalisation do not end the CURRENT lookup", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.close()`);
  await h(page, `__fake.hold('B'); __harness.open('B')`);
  await waitGet(page, 'B');
  // A fails late while B's lookup is still pending. If A's finalisation ended
  // "resolving" for B's opening, the default (Alex's last role, D) would be
  // applied and Start enabled for D before B's reply arrived.
  await h(page, `__fake.release('A', true)`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).not.toContainText('Role D');
  await expect(startBtn(page)).toBeDisabled();
  await h(page, `__fake.release('B')`);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});
