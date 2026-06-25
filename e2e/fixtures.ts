import { test as base, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Playwright's _electron.launch() is broken on Electron 30+ (it passes
// --remote-debugging-port=0 as a CLI flag, which Electron rejects —
// microsoft/playwright#39008). So we spawn the built app ourselves with the E2E
// flag (the app then opens a fixed CDP port via appendSwitch, see src/main/index.ts)
// and connect with chromium.connectOverCDP. Tests drive the dashboard via window.api.

// Playwright transpiles tests to CommonJS, so require() is available here;
// require('electron') resolves to the path of the electron binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin = require('electron') as unknown as string;
const APP_ENTRY = resolve(process.cwd(), 'out/main/index.js');
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9222);

/** True when a real OpenAI key is available (live tier). Tests needing OpenAI
 *  `test.skip(!hasKey, …)` so the suite still passes in CI without a key. */
export const hasKey = !!process.env.OPENAI_API_KEY;

async function waitForCDP(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Electron CDP endpoint never came up on :${port} — ${String(lastErr)}`);
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

interface Fixtures {
  /** The dashboard BrowserWindow (loaded WITHOUT a ?view= param). */
  dashboard: Page;
}

export const test = base.extend<Fixtures>({
  dashboard: async ({}, use, testInfo) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BRAINCUE_E2E: '1',
      E2E_CDP_PORT: String(CDP_PORT),
      E2E_USER_DATA: resolve(testInfo.outputDir, 'userData'), // isolated DB per test
    };
    // The Playwright runner sets ELECTRON_RUN_AS_NODE, which would make our spawned
    // Electron run as plain Node (electron.app === undefined). Strip it so it boots
    // as a real Electron app.
    delete env.ELECTRON_RUN_AS_NODE;

    const proc = spawn(electronBin, [APP_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    let browser: Browser | undefined;
    try {
      await waitForCDP(CDP_PORT);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const ctx = browser.contexts()[0];

      // Electron windows surface as CDP pages; the overlay/selection load with
      // ?view=…, the dashboard doesn't. Poll — windows appear asynchronously.
      const findDash = () =>
        ctx.pages().find((p) => {
          const u = p.url();
          return u && !u.startsWith('about:') && !u.includes('view=');
        });
      const deadline = Date.now() + 15_000;
      let dash = findDash();
      while (!dash && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        dash = findDash();
      }
      if (!dash) {
        throw new Error('dashboard window not found; open pages: ' + ctx.pages().map((p) => p.url()).join(', '));
      }

      await dash.waitForLoadState('domcontentloaded');
      // Mark first-run flags, then reload so the guided tour (a full-screen overlay
      // that intercepts clicks) doesn't auto-start — it fires on mount, before we
      // could dismiss it, so we set the flag and re-boot the renderer clean.
      await dash.evaluate(async () => {
        await (window as unknown as { api?: { settings: { set: (p: unknown) => Promise<unknown> } } }).api?.settings.set({
          tourDone: true,
          dataConsentAck: true,
        });
      });
      await dash.reload();
      await dash.waitForLoadState('domcontentloaded');

      await use(dash);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n--- electron stderr (tail) ---\n${stderr.slice(-2000)}`);
    } finally {
      await browser?.close().catch(() => {});
      // Await the process exit so port 9222 is free before the next test spawns —
      // otherwise the next connectOverCDP can hit this dying instance ("target closed").
      if (proc.pid && proc.exitCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()));
        killTree(proc.pid);
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000))]);
      }
    }
  },
});

/** Inject the real API key (live tier) via the typed preload facade. No-op without a key. */
export async function setApiKey(dashboard: Page): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return;
  await dashboard.evaluate(async (k) => {
    await (window as unknown as { api: { settings: { setApiKey: (k: string) => Promise<unknown> } } }).api.settings.setApiKey(k);
  }, key);
}

export { expect };
