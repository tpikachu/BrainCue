import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, hasKey, setApiKey, type Page } from './fixtures';
import { MEMORIES, PROFILE, SPACE } from '../src/main/services/engine/bench/perf01.fixtures';
import {
  audioFor,
  bindRun,
  configFromEnv,
  FRAME_MS,
  latencyRows,
  ledger,
  meterBinding,
  meterEnv,
  paths,
  runBlock,
  seedRun,
  TAIL_SILENCE_MS,
  windowsSnapshot,
  type AppPort,
  type WatchState,
} from '../src/main/services/engine/bench/perf01.driver';
import { fixtureText, liveReport, readEvidence, WARMUP_ID } from '../src/main/services/engine/bench/perf01.evidence';
import { GENERAL, TECHNICAL } from '../src/main/services/engine/bench/perf01.fixtures';

/**
 * PERF-01 LIVE BENCHMARK (M7.2b). Prepared, NOT run. It runs only with
 * PERF01_LIVE=1 and a key, by the targeted command in
 * docs/benchmarks/PERF01-LIVE-PLAN.md, and needs that plan approved first.
 * It sends SYNTHETIC fixture data to OpenAI and costs money.
 *
 * This file registers the tests and adapts Playwright's pages to the
 * driver's `AppPort`. The driver itself (attribution, takes, budget,
 * preflight, reconciliation, stopping) is
 * src/main/services/engine/bench/perf01.driver.ts, tested offline against a
 * fake app.
 *
 * The tests run in SERIAL mode, so a failed test skips every later one. The
 * driver enforces the same thing on its own: no block starts after any block
 * of the run has stopped.
 *
 * PERF01_DRY=1 checks the real app path OFFLINE, under the offline guard:
 * - the manifest and the meter's installed caps;
 * - the seed and a fresh process on its copy;
 * - the window snapshot;
 * - the audio;
 * - the report gate.
 * No session starts and no provider is called.
 */

const LIVE = process.env.PERF01_LIVE === '1';
const CFG = configFromEnv(process.env);
const METER = resolve('scripts/perf01/live-meter.cjs');

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The driver's view of the app, over the dashboard and Cue Card pages. */
function pageApp(dashboard: Page): AppPort {
  const overlay = () => {
    const o = dashboard
      .context()
      .pages()
      .find((p) => p.url().includes('view=overlay'));
    if (!o) throw new Error('no Cue Card page');
    return o;
  };
  const call = <T>(fn: (arg: any) => Promise<T> | T, arg?: unknown) => dashboard.evaluate(fn as any, arg) as Promise<T>;
  return {
    setApiKey: () => setApiKey(dashboard),
    settingsSet: async (patch) => void (await call((p) => (window as any).api.settings.set(p), patch)),
    setUp: (withMemories) =>
      call(
        async ({ profile, space, memories, withMemories }: any) => {
          const a = (window as any).api;
          const p = await a.profiles.create({ name: profile.name, targetRole: profile.targetRole, targetCompany: profile.targetCompany, resumeText: profile.resumeText });
          await a.documents.reindexProfile(p.id);
          // Company research is normally scraped from a URL; here it rides with the JD.
          const { job } = await a.jobs.save({ profileId: p.id, kind: 'job', title: space.title, company: space.company, jdUrl: null, jdText: `${space.jdText}\n\n${space.companyResearch}`, companyUrl: null, notes: null });
          if (withMemories) for (const m of memories) await a.memory.create(p.id, m.content, { category: 'preference' });
          return { profileId: p.id as string, packId: job.id as string };
        },
        { profile: PROFILE, space: SPACE, memories: MEMORIES, withMemories },
      ),
    startSession: async (profileId, packId, format) => {
      const s = await call(({ p, k, f }: any) => (window as any).api.session.start(p, 'general', k, f, 'job'), { p: profileId, k: packId, f: format });
      return (s as any)?.id ?? (s as any)?.session?.id;
    },
    stopSession: async (sid) => void (await call((id) => (window as any).api.session.stop(id), sid)),
    stream: (sid, b64) =>
      call(
        async ({ sid, b64, frameMs, tailMs }: any) => {
          const a = (window as any).api;
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const frame = (24000 * 2 * frameMs) / 1000;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const t0 = performance.now();
          let i = 0;
          const send = (chunk: Uint8Array) => a.session.sendRealtimeAudio(sid, chunk.slice().buffer, 'system');
          for (let off = 0; off < bytes.length; off += frame) {
            send(bytes.subarray(off, off + frame));
            await sleep(Math.max(0, t0 + ++i * frameMs - performance.now()));
          }
          const silence = new Uint8Array(frame);
          for (let k = 0; k < tailMs / frameMs; k++) {
            send(silence);
            await sleep(Math.max(0, t0 + ++i * frameMs - performance.now()));
          }
        },
        { sid, b64, frameMs: FRAME_MS, tailMs: TAIL_SILENCE_MS },
      ),
    // Watched in the Cue Card page: it alone is told each take (latencyTake).
    watch: async () => {
      await overlay().evaluate(() => {
        const w = window as any;
        const s = (w.__perf01 = { questions: {} as Record<string, any>, contexts: {} as Record<string, Record<string, unknown>> });
        w.api.events.onQuestionDetected((p: any) => {
          if (!p || typeof p.id !== 'string') return;
          const q = s.questions[p.id];
          s.questions[p.id] = { id: p.id, text: String(p.text ?? ''), at: q?.at ?? Date.now(), ...(q?.take ? { take: q.take } : {}) };
        });
        w.api.events.onContributionPatch((p: any) => {
          const id = p.contributionId;
          if (typeof p.latencyTake === 'number') {
            const q = (s.questions[id] ??= { id, text: '', at: Date.now() });
            q.take = Math.max(q.take ?? 0, p.latencyTake);
          }
          if (typeof p.title === 'string' && s.questions[id]) s.questions[id].text = p.title;
          if (p.context) (s.contexts[id] ??= {})[String(s.questions[id]?.take ?? 0)] = { chunks: p.context.chunks?.map((c: any) => c.content), memories: p.context.memories?.map((m: any) => m.content) };
        });
      });
    },
    watched: () => overlay().evaluate(() => ((window as any).__perf01 ?? { questions: {}, contexts: {} }) as WatchState),
    settings: () => call(() => (window as any).api.settings.get()),
    readiness: () => call(() => (window as any).api.settings.readiness()),
    profiles: () => call(() => (window as any).api.profiles.list()),
    overlayVisibility: async () => {
      try {
        return await overlay().evaluate(() => document.visibilityState);
      } catch {
        return 'no overlay page';
      }
    },
    latencySummary: () => call(() => (window as any).api.metrics.latency()),
    wait: (ms) => dashboard.waitForTimeout(ms),
    now: () => Date.now(),
  };
}

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

test.describe('PERF-01 live benchmark', () => {
  test.skip(!CFG.dry && (!LIVE || !hasKey), 'Live PERF-01 runs only with PERF01_LIVE=1, a key, and the approved plan.');
  if (CFG.dry) test.use({ live: false }); // offline: the guard refuses every request
  test.use({ mainPreloads: [METER], appEnv: meterEnv(CFG) });
  test.describe.configure({ mode: 'serial' });

  // One run, one configuration: a folder that already holds a manifest is refused.
  test.beforeAll(() => {
    bindRun(CFG, { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length });
  });

  test.describe('seed', () => {
    test.use({ userDataDir: paths(CFG).seed });
    test('seed: the synthetic profile, Space and memories, set up once', async ({ dashboard }) => {
      test.setTimeout(5 * 60_000);
      const seed = await seedRun(pageApp(dashboard), CFG, Date.now());
      expect(seed.profileId).toBeTruthy();
      expect(seed.packId).toBeTruthy();
    });
  });

  test.describe('blocks', () => {
    test.use({ seedUserData: paths(CFG).seed });

    test('dry run: seed copy, meter binding, window snapshot, audio and the report gate (offline)', async ({ dashboard }, info) => {
      test.skip(!CFG.dry, 'PERF01_DRY=1 only');
      const ids = [WARMUP_ID, ...GENERAL.map((q) => q.id), ...TECHNICAL.map((q) => q.id)];
      const audio = audioFor(CFG, ids);
      for (const [id, b64] of Object.entries(audio)) {
        const seconds = Buffer.from(b64, 'base64').length / (24000 * 2);
        expect(seconds, `${id} has speech (${fixtureText(id).slice(0, 30)}…)`).toBeGreaterThan(1);
        expect(seconds, `${id} is a short question`).toBeLessThan(10);
      }
      const app = pageApp(dashboard);
      // A fresh process on a COPY of the seed: the profile is there, the latency file is new.
      expect(JSON.stringify(await app.profiles())).toContain(JSON.parse(readFileSync(paths(CFG).seedIds, 'utf8')).profileId);
      expect(latencyRows(resolve(info.outputDir, 'userData'))).toEqual([]);
      // The meter is loaded once in this process, with the manifest's caps, and sent nothing.
      const bound = meterBinding(CFG, Date.now());
      expect(bound.failures).toEqual([]);
      const m = ledger(CFG);
      expect(m?.processes.length).toBe(2); // the seed's process, and this one
      expect(m?.requests).toBe(0);
      // Its window snapshot is fresh, from this process; with a second display, the dashboard is on it.
      await dashboard.waitForTimeout(1500);
      const snap = windowsSnapshot(CFG);
      expect(snap?.pid).toBe(bound.pid);
      const dash = snap?.windows.find((w) => w.view === 'dashboard');
      if (snap?.displays.some((d) => !d.primary)) expect(dash?.onPrimary, 'the dashboard is on the secondary display').toBe(false);
      // The report gate on this folder: a dry, unrun plan is never acceptance.
      const { validated, report } = liveReport(readEvidence(CFG.out));
      expect(validated.valid).toBe(false);
      expect(validated.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['dry-run', 'block-missing', 'fixture-missing']));
      expect(report.verdicts.general.usefulP50).not.toBe('met');
      writeFileSync(join(CFG.out, 'dry.json'), JSON.stringify({ questions: Object.keys(audio).length, meter: m, windows: snap, issues: validated.issues.map((i) => i.code) }, null, 2));
    });

    test('warm General: one warm-up, then G01–G30', async ({ dashboard }, info) => {
      test.skip(CFG.dry, 'live only');
      test.setTimeout(45 * 60_000);
      await runBlock(pageApp(dashboard), CFG, 'warm-general', resolve(info.outputDir, 'userData'));
    });

    test('warm Technical: one warm-up, then T01–T30', async ({ dashboard }, info) => {
      test.skip(CFG.dry, 'live only');
      test.setTimeout(45 * 60_000);
      await runBlock(pageApp(dashboard), CFG, 'warm-technical', resolve(info.outputDir, 'userData'));
    });

    // Each test is a fresh app process (its own copy of the seed), so its one
    // question is that process's first answer: a cold start.
    for (let i = 1; i <= 10; i++) {
      test(`cold start ${i}: a fresh process`, async ({ dashboard }, info) => {
        test.skip(CFG.dry, 'live only');
        test.setTimeout(5 * 60_000);
        await runBlock(pageApp(dashboard), CFG, `cold-${i}`, resolve(info.outputDir, 'userData'));
      });
    }
  });
});
