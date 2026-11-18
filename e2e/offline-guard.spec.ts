import { test, expect } from './fixtures';

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
