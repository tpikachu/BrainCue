import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { test, expect, type GuardEntry } from './fixtures';

/**
 * The offline tier proves its own isolation (e2e/offline-guard.cjs), so a
 * passing run can be trusted to have used no provider, no network and no real
 * capture device. Every other offline test also fails if the guard ever
 * records a GRANT (fixtures.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

test('no key of any kind, and capture is refused before any device opens', async ({ dashboard, guardLog }) => {
  const out = await dashboard.evaluate(async () => {
    const api = (window as any).api;
    const settings = await api.settings.get();
    const readiness = await api.settings.readiness();
    const attempt = async (f: () => Promise<MediaStream>) => {
      try {
        const s = await f();
        s.getTracks().forEach((t) => t.stop());
        return 'GRANTED';
      } catch (e) {
        return (e as DOMException).name;
      }
    };
    return {
      apiKeyPresent: settings.apiKeyPresent,
      providerKeys: settings.providerKeys,
      chatReady: readiness.chat.ready,
      mic: await attempt(() => navigator.mediaDevices.getUserMedia({ audio: true })),
      callAudio: await attempt(() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })),
    };
  });
  expect(out.apiKeyPresent).toBeFalsy();
  expect(Object.values(out.providerKeys ?? {}).filter(Boolean)).toEqual([]);
  expect(out.chatReady).toBe(false);
  expect(out.mic).toBe('NotAllowedError');
  expect(out.callAudio).toBe('NotAllowedError');
  const capture = guardLog().filter((e) => e.kind === 'capture');
  expect(capture.map((e) => e.api)).toEqual(expect.arrayContaining(['getUserMedia', 'getDisplayMedia']));
  expect(capture.every((e) => e.granted === false)).toBe(true);
});

test("a provider call from main, and a request from the page, never leave the machine", async ({ dashboard, guardLog }) => {
  const out = await dashboard.evaluate(async () => {
    const api = (window as any).api;
    // A dummy key makes main actually TRY the provider.
    await api.settings.setProviderKey('anthropic', 'sk-ant-offline-e2e-not-a-key');
    const tested = await api.settings.testProviderKey('anthropic').catch((e: Error) => ({ ok: false, error: e.message }));
    let page = 'sent';
    try {
      await fetch('https://example.com/');
    } catch {
      page = 'refused';
    }
    return { tested, page };
  });
  expect(out.tested.ok).toBe(false);
  expect(out.page).toBe('refused');
  const net = guardLog().filter((e) => e.kind === 'net');
  expect(net.some((e) => /anthropic\.com$/.test(e.host ?? ''))).toBe(true);
  expect(net.every((e) => e.refused === true)).toBe(true);
});

// ---- Isolation regressions (M7.1 review): every path the guard must close ----

/** The guard under test (overridable, to run these probes against an older one). */
const GUARD = process.env.E2E_GUARD_UNDER_TEST || resolve(__dirname, 'offline-guard.cjs');

/** Run a probe in plain Node with the guard preloaded; its JSON and the log. */
async function probe(script: string, args: (string | number)[], log: string): Promise<{ out: any; log: GuardEntry[] }> {
  rmSync(log, { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_GUARD_LOG: log };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  // Async: the loopback servers the probe talks to live in THIS process.
  const child = spawn(process.execPath, ['--require', GUARD, resolve(__dirname, 'guard-probes', script), ...args.map(String)], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise<number | null>((done) => {
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('exit', (c) => {
      clearTimeout(t);
      done(c);
    });
  });
  if (code !== 0) throw new Error(`probe failed (${code}): ${stderr}`);
  const entries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { out: JSON.parse(stdout), log: entries };
}

/** A loopback HTTP server that counts what reaches it. */
async function server(host: string, handler?: (url: string, res: ServerResponse) => boolean) {
  const hits: string[] = [];
  const srv: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (handler?.(req.url ?? '', res)) return;
    res.end('ok');
  });
  await new Promise<void>((r) => srv.listen(0, host, () => r()));
  return { port: (srv.address() as AddressInfo).port, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('network: a mapped IPv6 address, a redirect hop and a raw socket cannot reach a forbidden host; loopback still can', async ({}, testInfo) => {
  // 127.0.0.2 is loopback on the wire, but the guard allows only 127.0.0.1 /
  // ::1 — so it stands in for a remote host without any traffic leaving.
  const target = await server('127.0.0.2');
  const redirect = await server('127.0.0.1', (_url, res) => {
    res.writeHead(302, { Location: `http://127.0.0.2:${target.port}/via-redirect` });
    res.end();
    return true;
  });
  const control = await server('127.0.0.1');
  try {
    const { out, log } = await probe('net-probe.cjs', [target.port, redirect.port, control.port], testInfo.outputPath('net-probe.jsonl'));
    // Nothing reached the forbidden target — directly, mapped, redirected or raw.
    expect(target.hits).toEqual([]);
    for (const k of ['direct', 'mappedHex', 'mappedDotted', 'redirect', 'httpMapped', 'socket']) {
      expect(out[k], k).toMatch(/^refused/);
    }
    // Each attempt is on the record — including the redirect's second hop.
    const refusedHosts = log.filter((e) => e.kind === 'net' && e.refused).map((e) => e.host);
    expect(refusedHosts.filter((h) => h === '127.0.0.2').length).toBeGreaterThanOrEqual(3); // direct, redirect hop, socket
    expect(refusedHosts.filter((h) => /^::ffff:/.test(h ?? '')).length).toBeGreaterThanOrEqual(3); // both mapped spellings + http
    expect(redirect.hits).toEqual(['/to-target']); // the allowed first hop happened…
    expect(log.every((e) => e.refused === true)).toBe(true); // …and nothing was let through unlogged
    // Controls: loopback is allowed, in each spelling.
    expect([out.control, out.controlMapped, out.controlHttp]).toEqual(['status 200', 'status 200', 'status 200']);
    expect(control.hits.sort()).toEqual(['/control', '/control-http', '/control-mapped']);
  } finally {
    await Promise.all([target.close(), redirect.close(), control.close()]);
  }
});

test('screen: a native screenshot is refused before the capture API runs (fake Electron transport)', async ({}, testInfo) => {
  const { out, log } = await probe('capture-probe.cjs', [], testInfo.outputPath('capture-probe.jsonl'));
  expect(out.realGetSourcesCalls).toBe(0); // the real transport was never called
  expect(out.screenshot).toMatch(/^refused: screen capture refused by the offline E2E guard/);
  expect(out.media).toBe(false); // control: the app's granting handler is overridden
  expect(log).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'capture', via: 'desktopCapturer', types: ['screen'], granted: false }),
      expect.objectContaining({ kind: 'capture', via: 'permission-request', permission: 'media', granted: false }),
    ]),
  );
});

test("screen: the app's real region capture (capture:region → captureScreen) is refused in the running app", async ({ dashboard, guardLog }) => {
  const result = await dashboard.evaluate(async () => {
    try {
      const r = await (window as any).api.capture.region();
      return { got: typeof r?.image === 'string' ? 'IMAGE' : 'something' };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  expect(result).toEqual({ error: expect.stringMatching(/screen capture refused by the offline E2E guard/) });
  expect(guardLog()).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'capture', via: 'desktopCapturer', types: ['screen'], granted: false })]),
  );
});
