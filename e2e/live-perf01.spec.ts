import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test, expect, hasKey, setApiKey, type Page } from './fixtures';
import { GENERAL, MEMORIES, PROFILE, SPACE, TECHNICAL } from '../src/main/services/engine/bench/perf01.fixtures';
import { attributeAll, collectAnswer, settle, type CollectDeps, type Collected, type DetectedQuestion, type FixtureText } from '../src/main/services/engine/bench/perf01.collect';
import { capsFromEnv, runBlockLoop, type LoopDeps } from '../src/main/services/engine/bench/perf01.budget';
import {
  fixtureText,
  liveReport,
  planRun,
  readEvidence,
  REFERENCE,
  WARMUP_ID,
  type BlockLog,
  type Manifest,
  type MeterState,
  type PlannedBlock,
  type SampleLine,
} from '../src/main/services/engine/bench/perf01.evidence';
import type { Row } from '../src/main/services/engine/metrics/report';

/**
 * PERF-01 LIVE DRIVER (M7.2b). Prepared, NOT run. It runs only with
 * PERF01_LIVE=1 and a key, by the targeted command in
 * docs/benchmarks/PERF01-LIVE-PLAN.md, and needs that plan approved first.
 * It sends SYNTHETIC fixture data (perf01.fixtures.ts) to OpenAI and costs
 * money.
 *
 * The real app and pipeline. Each question is synthesized locally to speech
 * (scripts/perf01/make-audio.ps1: no network, no device) and streamed through
 * the app's own audio IPC (`session.sendRealtimeAudio`) at real-time pace, so
 * speech end → final is real speech-to-text. Timing comes from the app's own
 * latency record (<userData>/metrics/latency.jsonl).
 *
 * The driver:
 *
 * - **Attributes** each record to its fixture by the question the app
 *   detected (or, with no text, by when its final arrived), never by row
 *   order (bench/perf01.collect.ts). It waits for earlier answers to settle
 *   before the next question.
 * - **Runs under a budget** enforced in main by the meter
 *   (scripts/perf01/live-meter.cjs). Every provider request's upper bound is
 *   reserved before it is sent, setup and auxiliary calls included, across
 *   every app process. The meter also refuses capture and any non-provider
 *   host. The driver checks a whole question's worst case before each
 *   question (bench/perf01.budget.ts).
 * - **Preflights** every block before any audio: the reference route,
 *   speech-to-text and retrieval, and both windows visible on a
 *   secondary display.
 * - **Records a manifest** (manifest.json) of what was planned. The report
 *   validates the results against it (bench/perf01.evidence.ts).
 *
 * Setup (profile, Space, memories, indexing) runs ONCE, in the seed. Every
 * block starts a fresh app process on a copy of the seed's user data.
 *
 * PERF01_DRY=1 checks all of this OFFLINE, under the offline guard. It
 * covers the seed, the copy, the meter's ledger and window snapshot, the
 * audio, and the report gate. No session starts and no provider is called.
 */

const LIVE = process.env.PERF01_LIVE === '1';
const DRY = process.env.PERF01_DRY === '1';
const OUT = resolve(process.env.PERF01_OUT || join('bench-results', 'perf01', `${DRY ? 'dry' : 'live'}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const RUN_ID = basename(OUT);
const LEDGER = join(OUT, 'ledger');
const SEED = join(OUT, 'seed-userData');
const METER = resolve('scripts/perf01/live-meter.cjs');
const CAPS = capsFromEnv(process.env);
const QUESTION_TIMEOUT_MS = Number(process.env.PERF01_QUESTION_TIMEOUT_MS || 30_000);
const SETTLE_MS = Number(process.env.PERF01_SETTLE_MS || 30_000);
const GAP_MS = Number(process.env.PERF01_GAP_MS || 15_000);
const FRAME_MS = 100;
const TAIL_SILENCE_MS = 1500; // lets the server VAD end the turn

// eslint-disable-next-line @typescript-eslint/no-require-imports
const meterCore = require('../scripts/perf01/meter-core.cjs') as { load(dir: string): MeterState };
const ledger = (): MeterState | null => (existsSync(join(LEDGER, 'meter.json')) ? meterCore.load(LEDGER) : null);

/* eslint-disable @typescript-eslint/no-explicit-any */

const ALL = [{ id: WARMUP_ID, text: fixtureText(WARMUP_ID) }, ...GENERAL, ...TECHNICAL];

// ---- audio ------------------------------------------------------------------
function audioFor(ids: string[]): Record<string, string> {
  const dir = join(OUT, 'audio');
  mkdirSync(dir, { recursive: true });
  const missing = ids.filter((id) => !existsSync(join(dir, `${id}.wav`)));
  if (missing.length) {
    const list = join(OUT, 'questions.json');
    writeFileSync(list, JSON.stringify(missing.map((id) => ({ id, text: fixtureText(id) }))));
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/perf01/make-audio.ps1'), '-Questions', list, '-OutDir', dir], { stdio: 'inherit' });
  }
  return Object.fromEntries(ids.map((id) => [id, pcmOf(readFileSync(join(dir, `${id}.wav`))).toString('base64')]));
}

/** The PCM16 24 kHz mono samples of a WAV (its `data` chunk). */
export function pcmOf(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 24000 || wav.readUInt16LE(34) !== 16 || wav.readUInt16LE(22) !== 1)
    throw new Error('expected PCM16 24 kHz mono WAV');
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
const secondsOf = (b64: string) => Buffer.from(b64, 'base64').length / (24000 * 2) + TAIL_SILENCE_MS / 1000;

// ---- evidence files ---------------------------------------------------------
const appendLine = (file: string, v: unknown) => appendFileSync(join(OUT, file), JSON.stringify(v) + '\n');
const manifest = (): Manifest => JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
const planned = (block: string): PlannedBlock => manifest().blocks.find((b) => b.block === block)!;
const seedIds = (): { profileId: string; packId: string } => JSON.parse(readFileSync(join(OUT, 'seed.json'), 'utf8'));

function latencyRows(userData: string): Row[] {
  const file = join(userData, 'metrics', 'latency.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function questionsRun(): number {
  return existsSync(join(OUT, 'rows.jsonl'))
    ? readFileSync(join(OUT, 'rows.jsonl'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SampleLine)
        .filter((l) => l.outcome !== 'not-run').length
    : 0;
}

// ---- the app ----------------------------------------------------------------
/** The synthetic profile, Space and memories, through the app's own IPC. */
async function setUp(page: Page, withMemories: boolean): Promise<{ profileId: string; packId: string }> {
  return page.evaluate(
    async ({ profile, space, memories, withMemories }) => {
      const a = (window as any).api;
      const p = await a.profiles.create({ name: profile.name, targetRole: profile.targetRole, targetCompany: profile.targetCompany, resumeText: profile.resumeText });
      await a.documents.reindexProfile(p.id);
      // Company research is normally scraped from a URL; here it rides with the JD.
      const { job } = await a.jobs.save({ profileId: p.id, kind: 'job', title: space.title, company: space.company, jdUrl: null, jdText: `${space.jdText}\n\n${space.companyResearch}`, companyUrl: null, notes: null });
      // Approved memories need the embedding provider (not reachable offline).
      if (withMemories) for (const m of memories) await a.memory.create(p.id, m.content, { category: 'preference' });
      return { profileId: p.id as string, packId: (job as any).id as string };
    },
    { profile: PROFILE, space: SPACE, memories: MEMORIES, withMemories },
  );
}

/** The reference route, pinned so a discovery change mid-run cannot move it. */
async function pinReference(page: Page) {
  await setApiKey(page);
  await page.evaluate(
    (r) => (window as any).api.settings.set({ modelOverrides: { answer: r.answerModel, classify: r.classifyModel, parsing: r.parsingModel }, memoryEnabled: true }),
    REFERENCE,
  );
}

/** Detected questions (and revisions) and each answer's sent context. */
async function watchApp(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__perf01 = { context: {}, questions: {} };
    w.api.events.onQuestionDetected((p: any) => {
      if (p && typeof p.id === 'string') w.__perf01.questions[p.id] = { id: p.id, text: String(p.text ?? '') };
    });
    w.api.events.onContributionPatch((p: any) => {
      if (p.context) w.__perf01.context[p.contributionId] = { chunks: p.context.chunks?.map((c: any) => c.content), memories: p.context.memories?.map((m: any) => m.content) };
      if (typeof p.title === 'string' && w.__perf01.questions[p.contributionId]) w.__perf01.questions[p.contributionId].text = p.title;
    });
  });
}

const readQuestions = async (page: Page) =>
  new Map<string, DetectedQuestion>(Object.entries(await page.evaluate(() => (window as any).__perf01?.questions ?? {})) as [string, DetectedQuestion][]);

async function stream(page: Page, sid: string, b64: string) {
  await page.evaluate(
    async ({ sid, b64, frameMs, tailMs }) => {
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
  );
}

// ---- preflight --------------------------------------------------------------
interface WindowsSnapshot {
  at: number;
  pid: number;
  displays: { id: number; primary: boolean }[];
  windows: { view: string; visible: boolean; minimized: boolean; onPrimary: boolean }[];
  moves: unknown[];
}
const windowsSnapshot = (): WindowsSnapshot | null => (existsSync(join(LEDGER, 'windows.json')) ? JSON.parse(readFileSync(join(LEDGER, 'windows.json'), 'utf8')) : null);

/** Everything the run's validity rests on, checked before any audio is sent. */
async function preflight(page: Page, userData: string, blockStartedAt: number): Promise<{ ok: boolean; failures: string[]; checks: Record<string, unknown>; pid: number | null }> {
  const failures: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  const m = ledger();
  const pid = m?.processes.at(-1)?.pid ?? null;
  need(!!m && pid !== null && m.processes.at(-1)!.startedAt >= blockStartedAt - 60_000, 'the budget meter is loaded in this app process');
  need(!m?.capped, 'the budget is not capped');
  need(latencyRows(userData).length === 0, 'the latency file starts empty (fresh user-data copy)');

  const settings = await page.evaluate(() => (window as any).api.settings.get());
  const readiness = await page.evaluate(() => (window as any).api.settings.readiness());
  need(settings.effectiveModels?.answer === REFERENCE.answerModel, `answers route to ${REFERENCE.answerModel} (effective: ${settings.effectiveModels?.answer})`);
  need(settings.effectiveModels?.classify === REFERENCE.classifyModel, `detection routes to ${REFERENCE.classifyModel} (effective: ${settings.effectiveModels?.classify})`);
  need(!settings.modelNotices?.answer && !settings.modelNotices?.classify, 'no model notice on answer/classify');
  need(!settings.reasoningEfforts?.answer, 'no reasoning-effort override on answers');
  need(settings.stt?.engine === 'cloud' && settings.sttReady === true, 'cloud speech-to-text is ready');
  need(settings.memoryEnabled === true, 'memory is on');
  need(readiness.chat?.ready === true && readiness.chat.provider === REFERENCE.provider, `chat is ready on ${REFERENCE.provider}`);
  need(readiness.routes?.answer === 'openai' && readiness.routes?.classify === 'openai' && readiness.routes?.parsing === 'openai', 'every route is OpenAI');
  need(readiness.retrieval?.mode === 'embeddings', 'retrieval uses embeddings');
  const profiles = await page.evaluate(() => (window as any).api.profiles.list());
  need(JSON.stringify(profiles).includes(seedIds().profileId), 'the seeded profile is present');

  // Speech-to-text: what the session actually configured (seen by the meter).
  const deadline = Date.now() + 15_000;
  let stt = ledger()?.stt;
  while ((!stt || (stt as any).pid !== pid) && Date.now() < deadline) {
    await page.waitForTimeout(250);
    stt = ledger()?.stt;
  }
  need((stt as any)?.pid === pid && stt?.model === REFERENCE.sttModel, `speech-to-text is ${REFERENCE.sttModel} (seen: ${stt?.model ?? 'nothing'})`);
  need(stt?.silenceDurationMs === 600 && stt?.prefixPaddingMs === 300 && stt?.vad === 'server_vad', 'server VAD 300 ms prefix / 600 ms silence');

  // Windows: both visible, not minimized, on a secondary display.
  await page.waitForTimeout(1500); // the next snapshot, after the overlay was shown
  const snap = windowsSnapshot();
  need(!!snap && snap.pid === pid && Date.now() - snap.at < 5_000, 'a fresh window snapshot from this process');
  need(!!snap?.displays.some((d) => !d.primary), 'a secondary display exists');
  for (const view of ['dashboard', 'overlay']) {
    const w = snap?.windows.find((x) => x.view === view);
    need(!!w && w.visible && !w.minimized && !w.onPrimary, `the ${view} window is visible, not minimized, on the secondary display`);
  }
  const overlay = page.context().pages().find((p) => p.url().includes('view=overlay'));
  const visibility = overlay ? await overlay.evaluate(() => document.visibilityState) : 'no overlay page';
  need(visibility === 'visible', `the Cue Card page is visible to Chromium (${visibility})`);

  return {
    ok: failures.length === 0,
    failures,
    pid,
    checks: {
      effectiveModels: { answer: settings.effectiveModels?.answer, classify: settings.effectiveModels?.classify, parsing: settings.effectiveModels?.parsing },
      reasoningEfforts: settings.reasoningEfforts,
      stt,
      readiness: { chat: readiness.chat?.provider, model: readiness.chat?.model, classifyModel: readiness.chat?.classifyModel, routes: readiness.routes, retrieval: readiness.retrieval?.mode, transcription: readiness.transcription?.engine },
      windows: snap,
      overlayVisibility: visibility,
      budget: m ? { reservedTokens: m.reservedTokens, requests: m.requests, sttSeconds: m.sttSeconds } : null,
    },
  };
}

// ---- a block ----------------------------------------------------------------
async function runBlock(page: Page, block: string, userData: string) {
  const plan = planned(block);
  const startedAt = Date.now();
  appendLine('blocks.jsonl', { runId: RUN_ID, block, pid: null, startedAt, status: 'started' } satisfies BlockLog);
  const ids = [...(plan.warmup ? [plan.warmup] : []), ...plan.fixtures];
  const audio = audioFor(ids);
  const blockFixtures: FixtureText[] = ids.map((id) => ({ id, text: fixtureText(id) }));
  const fact = new Map(ALL.map((q) => [q.id, 'fact' in q ? (q as { fact: string }).fact : '']));
  let pf: Awaited<ReturnType<typeof preflight>> | undefined;
  let sid: string | undefined;
  let status: BlockLog['status'] = 'stopped';
  let reason: string | undefined;
  try {
    await pinReference(page);
    await watchApp(page);
    const { profileId, packId } = seedIds();
    const session = await page.evaluate(({ p, k, f }) => (window as any).api.session.start(p, 'general', k, f, 'job'), { p: profileId, k: packId, f: plan.format });
    sid = (session as any).id ?? (session as any).session?.id;
    expect(sid, 'session started').toBeTruthy();
    pf = await preflight(page, userData, startedAt);
    if (!pf.ok) {
      status = 'preflight-failed';
      reason = pf.failures.join('; ');
      for (const id of ids) appendLine('rows.jsonl', { runId: RUN_ID, block, fixtureId: id, pid: pf.pid, askedAt: Date.now(), grounded: null, outcome: 'not-run', reason: `preflight failed: ${reason}` } satisfies SampleLine);
      return;
    }
    const pid = pf.pid;
    const collectDeps: CollectDeps = {
      readRows: () => latencyRows(userData),
      readQuestions: () => readQuestions(page),
      now: () => Date.now(),
      sleep: (ms) => page.waitForTimeout(ms),
    };
    const deps: LoopDeps = {
      meter: ledger,
      asked: questionsRun,
      settle: () => settle(collectDeps, SETTLE_MS),
      send: async (q) => {
        const audioStartAt = Date.now();
        await stream(page, sid!, audio[q.id]);
        return { audioStartAt, audioEndAt: Date.now() };
      },
      collect: (q, windows) => collectAnswer(collectDeps, q, blockFixtures, windows, QUESTION_TIMEOUT_MS),
      record: async (q, c: Collected | null, at, notRun) => {
        const base = { runId: RUN_ID, block, fixtureId: q.id, pid, askedAt: at.audioStartAt, ...(at.audioEndAt ? { audioEndAt: at.audioEndAt } : {}) };
        if (notRun) return appendLine('rows.jsonl', { ...base, grounded: null, outcome: 'not-run', reason: notRun } satisfies SampleLine);
        if (!c?.sample)
          return appendLine('rows.jsonl', { ...base, grounded: null, outcome: 'no-record', reason: 'nothing attributed to this fixture within the timeout', extraQuestions: c?.extraQuestions, superseded: c?.superseded } as SampleLine);
        const ctx = await page.evaluate((id) => (window as any).__perf01?.context?.[id] ?? null, c.sample.questionId);
        const want = fact.get(q.id);
        const grounded = want ? !!ctx && JSON.stringify(ctx).includes(want) : null;
        appendLine('rows.jsonl', {
          ...c.sample,
          ...base,
          attribution: c.attribution,
          grounded,
          extraQuestions: c.extraQuestions,
          supersededTakes: c.superseded,
          usageReported: c.sample.promptTokens !== undefined && c.sample.completionTokens !== undefined,
        } as SampleLine);
      },
      audioSeconds: (q) => secondsOf(audio[q.id]),
      gap: () => page.waitForTimeout(GAP_MS),
    };
    const r = await runBlockLoop(deps, blockFixtures, CAPS, {
      countFailures: (c) => c.sample?.outcome !== 'answered' || !c.sample?.firstUsefulAt,
      firstMustPaint: !!plan.warmup,
    });
    status = r.status;
    reason = r.reason;
  } catch (e) {
    status = 'stopped';
    reason = `driver error: ${(e as Error).message.split('\n')[0]}`;
  } finally {
    // Evidence is kept on every exit: summary, raw records, attribution.
    try {
      const summary = await page.evaluate(() => (window as any).api.metrics.latency());
      writeFileSync(join(OUT, `${block}-summary.json`), JSON.stringify({ runId: RUN_ID, block, pid: pf?.pid ?? null, summary }, null, 2));
    } catch {
      /* the app may be gone; the block is then incomplete anyway */
    }
    const raw = latencyRows(userData);
    writeFileSync(join(OUT, `${block}-latency.jsonl`), raw.map((r) => JSON.stringify(r)).join('\n') + (raw.length ? '\n' : ''));
    try {
      const qs = await readQuestions(page);
      const windows = (readFileSync(join(OUT, 'rows.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) as SampleLine[])
        .filter((l) => l.block === block && l.outcome !== 'not-run')
        .map((l) => ({ id: l.fixtureId, audioStartAt: l.askedAt }));
      writeFileSync(join(OUT, `${block}-attribution.jsonl`), attributeAll(raw, qs, blockFixtures, windows).map((a) => JSON.stringify(a)).join('\n') + '\n');
    } catch {
      /* best effort */
    }
    if (sid) await page.evaluate((id) => (window as any).api.session.stop(id), sid).catch(() => {});
    appendLine('blocks.jsonl', { runId: RUN_ID, block, pid: pf?.pid ?? null, startedAt, endedAt: Date.now(), status, ...(reason ? { reason } : {}), ...(pf ? { preflight: { ok: pf.ok, failures: pf.failures, checks: pf.checks } } : {}) } satisfies BlockLog);
  }
  expect(status, `${block}: ${reason ?? ''}`).toBe('complete');
}

// ---- the run ----------------------------------------------------------------
const meterEnv = {
  PERF01_LEDGER: LEDGER,
  PERF01_CAP_TOKENS: String(CAPS.tokens),
  PERF01_CAP_REQUESTS: String(CAPS.requests),
  PERF01_CAP_STT_SECONDS: String(CAPS.sttSeconds),
  PERF01_PROVIDER_HOSTS: 'api.openai.com',
};

test.describe('PERF-01 live benchmark', () => {
  test.skip(!DRY && (!LIVE || !hasKey), 'Live PERF-01 runs only with PERF01_LIVE=1, a key, and the approved plan.');
  if (DRY) test.use({ live: false }); // offline: the guard refuses every request
  test.use({ mainPreloads: [METER], appEnv: meterEnv });
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    if (existsSync(join(OUT, 'manifest.json'))) return; // a resumed folder keeps its plan
    const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const m = planRun({ runId: RUN_ID, commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length, caps: { ...CAPS, questionTimeoutMs: QUESTION_TIMEOUT_MS, settleMs: SETTLE_MS, gapMs: GAP_MS }, dry: DRY });
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ ...m, node: process.version, platform: process.platform }, null, 2));
  });

  test.describe('seed', () => {
    test.use({ userDataDir: SEED });
    test('seed: the synthetic profile, Space and memories, set up once', async ({ dashboard }) => {
      test.setTimeout(5 * 60_000);
      if (LIVE) await pinReference(dashboard);
      const ids = await setUp(dashboard, !DRY);
      expect(ids.profileId).toBeTruthy();
      expect(ids.packId).toBeTruthy();
      writeFileSync(join(OUT, 'seed.json'), JSON.stringify({ ...ids, memoriesSkipped: DRY }, null, 2));
    });
  });

  test.describe('blocks', () => {
    test.use({ seedUserData: SEED });

    test('dry run: seed copy, meter ledger, window snapshot, audio and the report gate (offline)', async ({ dashboard }, info) => {
      test.skip(!DRY, 'PERF01_DRY=1 only');
      const audio = audioFor(ALL.map((q) => q.id));
      for (const [id, b64] of Object.entries(audio)) {
        const seconds = Buffer.from(b64, 'base64').length / (24000 * 2);
        expect(seconds, `${id} has speech`).toBeGreaterThan(1);
        expect(seconds, `${id} is a short question`).toBeLessThan(10);
      }
      // A fresh process on a COPY of the seed: the profile is there, the latency file is new.
      const profiles = await dashboard.evaluate(() => (window as any).api.profiles.list());
      expect(JSON.stringify(profiles)).toContain(seedIds().profileId);
      expect(latencyRows(resolve(info.outputDir, 'userData'))).toEqual([]);
      // The meter is loaded in this process, and sent nothing (offline: no key).
      const m = ledger();
      expect(m?.processes.length).toBe(2); // the seed's process, and this one
      expect(m?.requests).toBe(0);
      // Its window snapshot is fresh, from this process; with a second
      // display, the dashboard is on it.
      await dashboard.waitForTimeout(1500);
      const snap = windowsSnapshot();
      expect(snap?.pid).toBe(m?.processes.at(-1)?.pid);
      const dash = snap?.windows.find((w) => w.view === 'dashboard');
      if (snap?.displays.some((d) => !d.primary)) expect(dash?.onPrimary, 'the dashboard is on the secondary display').toBe(false);
      // The report gate on this folder: a dry, unrun plan is never acceptance.
      const { validated, report } = liveReport(readEvidence(OUT));
      expect(validated.valid).toBe(false);
      expect(validated.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['dry-run', 'block-missing', 'fixture-missing']));
      expect(report.verdicts.general.usefulP50).not.toBe('met');
      writeFileSync(join(OUT, 'dry.json'), JSON.stringify({ questions: Object.keys(audio).length, meter: m, windows: snap, issues: validated.issues.map((i) => i.code) }, null, 2));
    });

    test('warm General: one warm-up, then G01–G30', async ({ dashboard }, info) => {
      test.skip(DRY, 'live only');
      test.setTimeout(45 * 60_000);
      await runBlock(dashboard, 'warm-general', resolve(info.outputDir, 'userData'));
    });

    test('warm Technical: one warm-up, then T01–T30', async ({ dashboard }, info) => {
      test.skip(DRY, 'live only');
      test.setTimeout(45 * 60_000);
      await runBlock(dashboard, 'warm-technical', resolve(info.outputDir, 'userData'));
    });

    // Each test is a fresh app process (its own copy of the seed), so its one
    // question is that process's first answer: a cold start.
    for (let i = 1; i <= 10; i++) {
      test(`cold start ${i}: a fresh process`, async ({ dashboard }, info) => {
        test.skip(DRY, 'live only');
        test.setTimeout(5 * 60_000);
        await runBlock(dashboard, `cold-${i}`, resolve(info.outputDir, 'userData'));
      });
    }
  });
});
