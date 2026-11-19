import type { TestInfo } from '@playwright/test';

/**
 * PERF-01 test REGISTRATION, shared by the live spec (live-perf01.spec.ts)
 * and its offline regression (perf01-register.spec.ts, which passes a test
 * object with a fake app fixture).
 *
 * Which tests exist depends on the mode, and that is decided HERE, at
 * registration: an inactive test must never request the app fixture.
 * Playwright sets a test's fixtures up before its body runs, so a
 * `test.skip()` inside the body still launches the app. In a live run that
 * launch is a metered process belonging to no block, and the evidence check
 * rightly rejects the whole run (`process-unexpected`).
 */

export interface Perf01Mode {
  dry: boolean;
  live: boolean;
  hasKey: boolean;
}

export interface Perf01Steps<App> {
  /** Bind the results folder to the run (beforeAll). */
  bind(): void;
  seed(dashboard: App, info: TestInfo): Promise<void>;
  dry(dashboard: App, info: TestInfo): Promise<void>;
  block(dashboard: App, info: TestInfo, block: string): Promise<void>;
}

export interface Perf01Uses {
  /** Every test of the suite (the meter preload and its environment). */
  all?: Record<string, unknown>;
  /** Dry mode only (the offline tier). */
  dry?: Record<string, unknown>;
  seed?: Record<string, unknown>;
  blocks?: Record<string, unknown>;
}

export const BLOCK_TESTS: { block: string; title: string; minutes: number }[] = [
  { block: 'warm-general', title: 'warm General: one warm-up, then G01–G30', minutes: 45 },
  { block: 'warm-technical', title: 'warm Technical: one warm-up, then T01–T30', minutes: 45 },
  // Each is a fresh app process (its own copy of the seed): a cold start.
  ...Array.from({ length: 10 }, (_, i) => ({ block: `cold-${i + 1}`, title: `cold start ${i + 1}: a fresh process`, minutes: 5 })),
];
export const DRY_TEST = 'dry run: seed copy, meter binding, window snapshot, audio and the report gate (offline)';
export const SEED_TEST = 'seed: the synthetic profile, Space and memories, set up once';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerPerf01<App>(test: any, mode: Perf01Mode, steps: Perf01Steps<App>, uses: Perf01Uses = {}): void {
  test.describe('PERF-01 live benchmark', () => {
    test.skip(!mode.dry && (!mode.live || !mode.hasKey), 'Live PERF-01 runs only with PERF01_LIVE=1, a key, and the approved plan.');
    if (mode.dry && uses.dry) test.use(uses.dry);
    if (uses.all) test.use(uses.all);
    test.describe.configure({ mode: 'serial' });
    test.beforeAll(() => steps.bind());

    test.describe('seed', () => {
      if (uses.seed) test.use(uses.seed);
      test(SEED_TEST, async ({ dashboard }: { dashboard: App }, info: TestInfo) => {
        test.setTimeout(5 * 60_000);
        await steps.seed(dashboard, info);
      });
    });

    test.describe('blocks', () => {
      if (uses.blocks) test.use(uses.blocks);
      // Registered only in the mode that runs them: a skip inside the body
      // would come after the app fixture had already launched.
      if (mode.dry) {
        test(DRY_TEST, async ({ dashboard }: { dashboard: App }, info: TestInfo) => {
          await steps.dry(dashboard, info);
        });
      } else {
        for (const b of BLOCK_TESTS) {
          test(b.title, async ({ dashboard }: { dashboard: App }, info: TestInfo) => {
            test.setTimeout(b.minutes * 60_000);
            await steps.block(dashboard, info, b.block);
          });
        }
      }
    });
  });
}
