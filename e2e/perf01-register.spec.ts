import { test as base, expect } from '@playwright/test';
import { BLOCK_TESTS, DRY_TEST, registerPerf01, SEED_TEST, type Perf01Mode } from './perf01-register';

/**
 * PERF-01 registration, OFFLINE (review of e7a268b). The REAL registration
 * (perf01-register.ts, which live-perf01.spec.ts uses) runs under real
 * Playwright, once per mode. The only fake is the app fixture: it records
 * which tests initialize it, and launches nothing (no Electron, browser,
 * provider, audio or capture).
 *
 * The rule: only the tests a mode runs may initialize the app. In a live
 * run, any other launch is a metered process that belongs to no block, and
 * the evidence check rejects the run.
 */
function suite(name: string, mode: Perf01Mode, expected: { launched: string[]; ran: string[] }) {
  const launched: string[] = [];
  const ran: string[] = [];
  const test = base.extend<{ dashboard: string }>({
    dashboard: async ({}, use, info) => {
      launched.push(info.title);
      await use('fake app');
    },
  });
  test.describe(name, () => {
    registerPerf01<string>(test, mode, {
      bind: () => {},
      seed: async () => void ran.push('seed'),
      dry: async () => void ran.push('dry'),
      block: async (_app, _info, block) => void ran.push(block),
    });
    test.afterAll(() => {
      expect(launched, `${name}: the tests that initialized the app`).toEqual(expected.launched);
      expect(ran, `${name}: the steps that ran`).toEqual(expected.ran);
    });
  });
}

suite('live mode', { dry: false, live: true, hasKey: true }, {
  launched: [SEED_TEST, ...BLOCK_TESTS.map((b) => b.title)],
  ran: ['seed', ...BLOCK_TESTS.map((b) => b.block)],
});

suite('dry mode', { dry: true, live: false, hasKey: false }, {
  launched: [SEED_TEST, DRY_TEST],
  ran: ['seed', 'dry'],
});

suite('neither (no PERF01_LIVE / no key)', { dry: false, live: false, hasKey: false }, { launched: [], ran: [] });
