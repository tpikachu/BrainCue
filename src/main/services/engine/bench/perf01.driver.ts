import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Row } from '../metrics/report';
import { capsFromEnv, runBlockLoop, type LoopDeps, type RunCaps } from './perf01.budget';
import { attributeAll, collectAnswer, pickSample, settle, type Attribution, type CollectDeps, type Collected, type DetectedQuestion, type FixtureText, type FixtureWindow } from './perf01.collect';
import { fixtureText, METER_CAP_KEYS, planRun, REFERENCE, type BlockLog, type Manifest, type MeterState, type PlannedBlock, type SampleLine } from './perf01.evidence';
import { GENERAL, TECHNICAL } from './perf01.fixtures';

/**
 * PERF-01 LIVE DRIVER (M7.2b), the logic of e2e/live-perf01.spec.ts. The
 * spec only registers the tests and adapts Playwright's pages to
 * `AppPort`. Everything that decides what is measured, what is spent and
 * what is saved lives here, so it runs offline against a fake app
 * (perf01.driver.test.ts).
 *
 * - **One run, one configuration.** `bindRun` writes the manifest and
 *   refuses a folder that already holds one. Before anything is spent (the
 *   seed, every block), the meter in this app process must have installed
 *   exactly the manifest's caps.
 * - **A failed block fails, and ends the run.** Every unsuccessful exit
 *   (preflight, budget, in-flight work, a driver error) saves its evidence,
 *   stops the session, then throws. A later block refuses to start once any
 *   block of the run has stopped. That holds even if the runner went on.
 * - **Samples follow the current take.** A question is finished when its
 *   latest announced take is (perf01.collect.ts). Each block's lines are
 *   finalized once, at its end, from all its raw records and watched state.
 *   `rows.jsonl` holds the reconciled sample of each fixture, with that take's
 *   timing, attribution and grounding. The per-question progress is kept
 *   separately.
 */

export const FRAME_MS = 100;
export const TAIL_SILENCE_MS = 1500; // lets the server VAD end the turn

export interface DriverConfig {
  out: string;
  runId: string;
  dry: boolean;
  caps: RunCaps;
  questionTimeoutMs: number;
  settleMs: number;
  gapMs: number;
}

export function configFromEnv(env: Record<string, string | undefined>, now = new Date()): DriverConfig {
  const dry = env.PERF01_DRY === '1';
  const out = resolve(env.PERF01_OUT || join('bench-results', 'perf01', `${dry ? 'dry' : 'live'}-${now.toISOString().replace(/[:.]/g, '-')}`));
  return {
    out,
    runId: out.split(/[\\/]/).pop()!,
    dry,
    caps: capsFromEnv(env),
    questionTimeoutMs: Number(env.PERF01_QUESTION_TIMEOUT_MS || 30_000),
    settleMs: Number(env.PERF01_SETTLE_MS || 30_000),
    gapMs: Number(env.PERF01_GAP_MS || 15_000),
  };
}

export const paths = (cfg: Pick<DriverConfig, 'out'>) => ({
  ledger: join(cfg.out, 'ledger'),
  seed: join(cfg.out, 'seed-userData'),
  manifest: join(cfg.out, 'manifest.json'),
  seedIds: join(cfg.out, 'seed.json'),
  rows: join(cfg.out, 'rows.jsonl'),
  blocks: join(cfg.out, 'blocks.jsonl'),
  audio: join(cfg.out, 'audio'),
});

/** The caps recorded in the manifest: the run's whole configuration. */
export const manifestCaps = (cfg: DriverConfig): Record<string, number> => ({ ...cfg.caps, questionTimeoutMs: cfg.questionTimeoutMs, settleMs: cfg.settleMs, gapMs: cfg.gapMs });

/** What the app process is launched with: the meter, bound to these caps. */
export function meterEnv(cfg: DriverConfig): Record<string, string> {
  return {
    PERF01_LEDGER: paths(cfg).ledger,
    PERF01_CAP_TOKENS: String(cfg.caps.tokens),
    PERF01_CAP_REQUESTS: String(cfg.caps.requests),
    PERF01_CAP_STT_SECONDS: String(cfg.caps.sttSeconds),
    PERF01_PROVIDER_HOSTS: 'api.openai.com',
  };
}

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T) : null);
const readLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const appendLine = (file: string, v: unknown) => appendFileSync(file, JSON.stringify(v) + '\n');

export const ledger = (cfg: DriverConfig): MeterState | null => readJson<MeterState>(join(paths(cfg).ledger, 'meter.json'));
export const manifest = (cfg: DriverConfig): Manifest => {
  const m = readJson<Manifest>(paths(cfg).manifest);
  if (!m) throw new Error(`no manifest in ${cfg.out}: bindRun first`);
  return m;
};

/**
 * Bind the folder to this run's configuration. A folder that already holds
 * a manifest is refused: its evidence belongs to another configuration (or
 * an earlier attempt), and mixing them would make neither valid.
 */
export function bindRun(cfg: DriverConfig, git: { commit: string; dirty: number }): Manifest {
  mkdirSync(cfg.out, { recursive: true });
  if (existsSync(paths(cfg).manifest))
    throw new Error(`${cfg.out} already holds a run (manifest.json). A run is bound to one configuration: use a new PERF01_OUT.`);
  const m = planRun({ runId: cfg.runId, commit: git.commit, dirty: git.dirty, caps: manifestCaps(cfg), dry: cfg.dry });
  writeFileSync(paths(cfg).manifest, JSON.stringify({ ...m, node: process.version, platform: process.platform }, null, 2));
  return m;
}

/** The meter in the CURRENT app process (the latest one to load it) and
 *  whether it installed exactly the manifest's caps. Checked before spending. */
export function meterBinding(cfg: DriverConfig, since: number): { pid: number | null; failures: string[] } {
  const failures: string[] = [];
  const m = ledger(cfg);
  const proc = m?.processes.at(-1);
  if (!m || !proc || proc.startedAt < since - 60_000) return { pid: null, failures: ['the budget meter is not loaded in this app process'] };
  const want = manifest(cfg).caps;
  const off = METER_CAP_KEYS.filter((k) => proc.caps?.[k] !== want[k]);
  if (off.length) failures.push(`the meter installed caps ${JSON.stringify(proc.caps ?? null)}, the manifest says ${JSON.stringify(Object.fromEntries(METER_CAP_KEYS.map((k) => [k, want[k]])))}`);
  if (m.capped) failures.push(`the budget is already capped (${m.capped.reason})`);
  return { pid: proc.pid, failures };
}

// ---- the app edge ----------------------------------------------------------------

/** What the driver watches in the Cue Card page: every detected question
 *  (latest wording, detection time, latest announced take) and the context
 *  each take was sent with. */
export interface WatchState {
  questions: Record<string, DetectedQuestion>;
  contexts: Record<string, Record<string, { chunks?: string[]; memories?: string[] }>>;
}

/** Everything the driver does to the app. The spec implements it over
 *  Playwright pages; the tests implement it over a fake app. */
export interface AppPort {
  setApiKey(): Promise<void>;
  settingsSet(patch: Record<string, unknown>): Promise<void>;
  setUp(withMemories: boolean): Promise<{ profileId: string; packId: string }>;
  startSession(profileId: string, packId: string, format: string): Promise<string | undefined>;
  stopSession(sid: string): Promise<void>;
  stream(sid: string, b64: string): Promise<void>;
  watch(): Promise<void>;
  watched(): Promise<WatchState>;
  settings(): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readiness(): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  profiles(): Promise<unknown>;
  overlayVisibility(): Promise<string>;
  latencySummary(): Promise<unknown>;
  wait(ms: number): Promise<void>;
  now(): number;
}

// ---- audio -----------------------------------------------------------------------
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

/** Each question's speech, synthesized locally once (no network, no device). */
export function audioFor(cfg: DriverConfig, ids: string[]): Record<string, string> {
  const dir = paths(cfg).audio;
  mkdirSync(dir, { recursive: true });
  const missing = ids.filter((id) => !existsSync(join(dir, `${id}.wav`)));
  if (missing.length) {
    const list = join(cfg.out, 'questions.json');
    writeFileSync(list, JSON.stringify(missing.map((id) => ({ id, text: fixtureText(id) }))));
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/perf01/make-audio.ps1'), '-Questions', list, '-OutDir', dir], { stdio: 'inherit' });
  }
  return Object.fromEntries(ids.map((id) => [id, pcmOf(readFileSync(join(dir, `${id}.wav`))).toString('base64')]));
}
const secondsOf = (b64: string) => Buffer.from(b64, 'base64').length / (24000 * 2) + TAIL_SILENCE_MS / 1000;

export function latencyRows(userData: string): Row[] {
  return readLines<Row>(join(userData, 'metrics', 'latency.jsonl'));
}

// ---- the seed --------------------------------------------------------------------
export async function pinReference(app: AppPort) {
  await app.setApiKey();
  await app.settingsSet({ modelOverrides: { answer: REFERENCE.answerModel, classify: REFERENCE.classifyModel, parsing: REFERENCE.parsingModel }, memoryEnabled: true });
}

/** The synthetic profile, Space and memories, set up once for the run. */
export async function seedRun(app: AppPort, cfg: DriverConfig, startedAt: number): Promise<{ profileId: string; packId: string; pid: number }> {
  const bound = meterBinding(cfg, startedAt);
  if (bound.pid === null || bound.failures.length) throw new Error(`seed: not bound to the manifest: ${[...bound.failures].join('; ')}`);
  if (!cfg.dry) await pinReference(app);
  const ids = await app.setUp(!cfg.dry); // dry: memories need the embedding provider
  const seed = { ...ids, pid: bound.pid, memoriesSkipped: cfg.dry };
  writeFileSync(paths(cfg).seedIds, JSON.stringify(seed, null, 2));
  return seed;
}

// ---- preflight -------------------------------------------------------------------
interface WindowsSnapshot {
  at: number;
  pid: number;
  displays: { id: number; primary: boolean }[];
  windows: { view: string; visible: boolean; minimized: boolean; onPrimary: boolean }[];
}
export const windowsSnapshot = (cfg: DriverConfig): WindowsSnapshot | null => readJson<WindowsSnapshot>(join(paths(cfg).ledger, 'windows.json'));

export interface Preflight {
  ok: boolean;
  failures: string[];
  checks: Record<string, unknown>;
  pid: number | null;
}

/** Everything the run's validity rests on, checked before any audio is sent. */
export async function preflight(app: AppPort, cfg: DriverConfig, userData: string, blockStartedAt: number): Promise<Preflight> {
  const bound = meterBinding(cfg, blockStartedAt);
  const failures = [...bound.failures];
  const pid = bound.pid;
  const need = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  need(latencyRows(userData).length === 0, 'the latency file starts empty (fresh user-data copy)');
  const settings = await app.settings();
  const readiness = await app.readiness();
  need(settings.effectiveModels?.answer === REFERENCE.answerModel, `answers route to ${REFERENCE.answerModel} (effective: ${settings.effectiveModels?.answer})`);
  need(settings.effectiveModels?.classify === REFERENCE.classifyModel, `detection routes to ${REFERENCE.classifyModel} (effective: ${settings.effectiveModels?.classify})`);
  need(!settings.modelNotices?.answer && !settings.modelNotices?.classify, 'no model notice on answer/classify');
  need(!settings.reasoningEfforts?.answer, 'no reasoning-effort override on answers');
  need(settings.stt?.engine === 'cloud' && settings.sttReady === true, 'cloud speech-to-text is ready');
  need(settings.memoryEnabled === true, 'memory is on');
  need(readiness.chat?.ready === true && readiness.chat.provider === REFERENCE.provider, `chat is ready on ${REFERENCE.provider}`);
  need(readiness.routes?.answer === 'openai' && readiness.routes?.classify === 'openai' && readiness.routes?.parsing === 'openai', 'every route is OpenAI');
  need(readiness.retrieval?.mode === 'embeddings', 'retrieval uses embeddings');
  const seed = readJson<{ profileId: string }>(paths(cfg).seedIds);
  need(!!seed && JSON.stringify(await app.profiles()).includes(seed.profileId), 'the seeded profile is present');

  // Speech-to-text: what the session actually configured (seen by the meter).
  const deadline = app.now() + 15_000;
  let stt = ledger(cfg)?.stt as (MeterState['stt'] & { pid?: number }) | null | undefined;
  while ((!stt || stt.pid !== pid) && app.now() < deadline) {
    await app.wait(250);
    stt = ledger(cfg)?.stt as typeof stt;
  }
  need(stt?.pid === pid && stt?.model === REFERENCE.sttModel, `speech-to-text is ${REFERENCE.sttModel} (seen: ${stt?.model ?? 'nothing'})`);
  need(stt?.silenceDurationMs === 600 && stt?.prefixPaddingMs === 300 && stt?.vad === 'server_vad', 'server VAD 300 ms prefix / 600 ms silence');

  // Windows: both visible, not minimized, on a secondary display.
  await app.wait(1500); // the next snapshot, after the overlay was shown
  const snap = windowsSnapshot(cfg);
  need(!!snap && snap.pid === pid && app.now() - snap.at < 5_000, 'a fresh window snapshot from this process');
  need(!!snap?.displays.some((d) => !d.primary), 'a secondary display exists');
  for (const view of ['dashboard', 'overlay']) {
    const w = snap?.windows.find((x) => x.view === view);
    need(!!w && w.visible && !w.minimized && !w.onPrimary, `the ${view} window is visible, not minimized, on the secondary display`);
  }
  const visibility = await app.overlayVisibility();
  need(visibility === 'visible', `the Cue Card page is visible to Chromium (${visibility})`);
  const m = ledger(cfg);
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
      installedCaps: m?.processes.at(-1)?.caps ?? null,
      budget: m ? { reservedTokens: m.reservedTokens, requests: m.requests, sttSeconds: m.sttSeconds } : null,
    },
  };
}

// ---- reconciliation ----------------------------------------------------------------
/** What the loop recorded as it went (per fixture; `<block>-progress.jsonl`). */
export interface Progress {
  fixtureId: string;
  audioStartAt: number;
  audioEndAt?: number;
  notRun?: string;
  /** What was collected at the time (provisional; the final line is reconciled). */
  provisional?: { questionId: string | null; take: number | null; timedOut: boolean };
}

const FACTS = new Map<string, string>([...GENERAL, ...TECHNICAL].map((q) => [q.id, q.fact]));

/**
 * The block's final lines, from ALL its evidence once nothing is in flight:
 * every raw record, the latest wording and take of every question, and the
 * context each take was sent with. For each fixture asked, the sample is its
 * first question's current take: the same rule the loop waited on, applied
 * again now that later takes have arrived. If that take never finished, the
 * line says so and the fixture counts as unanswered.
 */
export function reconcileBlock(p: {
  runId: string;
  block: string;
  pid: number | null;
  ids: string[];
  progress: Progress[];
  rows: Row[];
  state: WatchState;
}): { lines: SampleLine[]; attributions: Attribution[] } {
  const fixtures: FixtureText[] = p.ids.map((id) => ({ id, text: fixtureText(id) }));
  const questions = new Map(Object.entries(p.state.questions));
  const asked = new Map(p.progress.map((x) => [x.fixtureId, x]));
  const windows: FixtureWindow[] = p.progress.filter((x) => !x.notRun).map((x) => ({ id: x.fixtureId, audioStartAt: x.audioStartAt }));
  const attributions = attributeAll(p.rows, questions, fixtures, windows);
  const lines = p.ids.map((id): SampleLine => {
    const a = asked.get(id);
    const base = { runId: p.runId, block: p.block, fixtureId: id, pid: p.pid, askedAt: a?.audioStartAt ?? 0, ...(a?.audioEndAt ? { audioEndAt: a.audioEndAt } : {}) };
    if (!a) return { ...base, grounded: null, outcome: 'not-run', reason: 'never asked: the block ended first' };
    if (a.notRun) return { ...base, grounded: null, outcome: 'not-run', reason: a.notRun };
    const pick = pickSample(p.rows, attributions, id, questions, fixtures, windows);
    const counts = { extraQuestions: pick.extraQuestions, supersededTakes: pick.superseded };
    if (!pick.sample)
      return {
        ...base,
        ...counts,
        grounded: null,
        outcome: 'no-record',
        reason: pick.pending ? `the current take (${pick.pending.take}) of its question never finished` : 'nothing attributed to this fixture',
      } as SampleLine;
    const ctx = p.state.contexts[pick.sample.questionId]?.[String(pick.sample.take)];
    const fact = FACTS.get(id);
    return {
      ...pick.sample,
      ...base,
      ...counts,
      attribution: attributions[p.rows.indexOf(pick.sample)],
      // The context THIS take was sent with; none recorded for it is a miss.
      grounded: fact ? !!ctx && JSON.stringify(ctx).includes(fact) : null,
      usageReported: pick.sample.promptTokens !== undefined && pick.sample.completionTokens !== undefined,
    } as SampleLine;
  });
  return { lines, attributions };
}

// ---- a block -----------------------------------------------------------------------
/** Has any block of this run already ended unsuccessfully? Then no later block starts. */
export function runStopped(cfg: DriverConfig): BlockLog | null {
  return readLines<BlockLog>(paths(cfg).blocks).find((l) => l.runId === cfg.runId && (l.status === 'stopped' || l.status === 'preflight-failed')) ?? null;
}

export async function runBlock(app: AppPort, cfg: DriverConfig, block: string, userData: string): Promise<BlockLog> {
  const stopped = runStopped(cfg);
  if (stopped) throw new Error(`${block}: not started — the run stopped at ${stopped.block} (${stopped.status}: ${stopped.reason ?? ''})`);
  const plan: PlannedBlock | undefined = manifest(cfg).blocks.find((b) => b.block === block);
  if (!plan) throw new Error(`${block}: not in the manifest`);
  const seed = readJson<{ profileId: string; packId: string }>(paths(cfg).seedIds);
  if (!seed) throw new Error(`${block}: no seed (seed.json): the seed step must run first`);
  const P = paths(cfg);
  const startedAt = app.now();
  appendLine(P.blocks, { runId: cfg.runId, block, pid: null, startedAt, status: 'started' } satisfies BlockLog);
  const ids = [...(plan.warmup ? [plan.warmup] : []), ...plan.fixtures];
  const fixtures: FixtureText[] = ids.map((id) => ({ id, text: fixtureText(id) }));
  const progressFile = join(cfg.out, `${block}-progress.jsonl`);
  const progress: Progress[] = [];
  const note = (x: Progress) => {
    progress.push(x);
    appendLine(progressFile, x);
  };
  let lastState: WatchState = { questions: {}, contexts: {} };
  const watched = async (): Promise<WatchState> => {
    try {
      lastState = await app.watched();
    } catch {
      /* the app may be gone: keep the last state seen */
    }
    return lastState;
  };
  let pf: Preflight | undefined;
  let sid: string | undefined;
  let status: BlockLog['status'] = 'stopped';
  let reason: string | undefined;
  try {
    const audio = audioFor(cfg, ids);
    await pinReference(app);
    await app.watch();
    sid = await app.startSession(seed.profileId, seed.packId, plan.format);
    if (!sid) throw new Error('the session did not start');
    pf = await preflight(app, cfg, userData, startedAt);
    if (!pf.ok) {
      status = 'preflight-failed';
      reason = pf.failures.join('; ');
      for (const id of ids) note({ fixtureId: id, audioStartAt: app.now(), notRun: `preflight failed: ${reason}` });
    } else {
      const collectDeps: CollectDeps = {
        readRows: () => latencyRows(userData),
        readQuestions: async () => new Map(Object.entries((await watched()).questions)),
        now: () => app.now(),
        sleep: (ms) => app.wait(ms),
      };
      const deps: LoopDeps = {
        meter: () => ledger(cfg),
        asked: () => questionsSpoken(cfg),
        settle: () => settle(collectDeps, cfg.settleMs),
        send: async (q) => {
          const audioStartAt = app.now();
          await app.stream(sid!, audio[q.id]);
          return { audioStartAt, audioEndAt: app.now() };
        },
        collect: (q, windows) => collectAnswer(collectDeps, q, fixtures, windows, cfg.questionTimeoutMs),
        record: (q, c: Collected | null, at, notRun) =>
          note({
            fixtureId: q.id,
            audioStartAt: at.audioStartAt,
            ...(at.audioEndAt ? { audioEndAt: at.audioEndAt } : {}),
            ...(notRun ? { notRun } : { provisional: { questionId: c?.questionId ?? null, take: c?.sample?.take ?? null, timedOut: !!c?.timedOut } }),
          }),
        audioSeconds: (q) => secondsOf(audio[q.id]),
        gap: () => app.wait(cfg.gapMs),
      };
      const r = await runBlockLoop(deps, fixtures, cfg.caps, {
        countFailures: (c) => c.sample?.outcome !== 'answered' || !c.sample?.firstUsefulAt,
        firstMustPaint: !!plan.warmup,
      });
      status = r.status;
      reason = r.reason;
    }
  } catch (e) {
    status = 'stopped';
    reason = `driver error: ${(e as Error).message.split('\n')[0]}`;
  } finally {
    // Evidence on every exit: the summary, the raw records, the reconciled
    // lines and their attribution, the block log.
    try {
      writeFileSync(join(cfg.out, `${block}-summary.json`), JSON.stringify({ runId: cfg.runId, block, pid: pf?.pid ?? null, summary: await app.latencySummary() }, null, 2));
    } catch {
      /* the app may be gone; the block is incomplete anyway */
    }
    const raw = latencyRows(userData);
    writeFileSync(join(cfg.out, `${block}-latency.jsonl`), raw.map((r) => JSON.stringify(r)).join('\n') + (raw.length ? '\n' : ''));
    const { lines, attributions } = reconcileBlock({ runId: cfg.runId, block, pid: pf?.pid ?? null, ids, progress, rows: raw, state: await watched() });
    for (const l of lines) appendLine(P.rows, l);
    writeFileSync(join(cfg.out, `${block}-attribution.jsonl`), attributions.map((a) => JSON.stringify(a)).join('\n') + (attributions.length ? '\n' : ''));
    writeFileSync(join(cfg.out, `${block}-watched.json`), JSON.stringify(lastState, null, 2));
    if (sid) await app.stopSession(sid).catch(() => {});
    appendLine(P.blocks, { runId: cfg.runId, block, pid: pf?.pid ?? null, startedAt, endedAt: app.now(), status, ...(reason ? { reason } : {}), ...(pf ? { preflight: { ok: pf.ok, failures: pf.failures, checks: pf.checks } } : {}) } satisfies BlockLog);
  }
  // After cleanup: anything but a complete block fails its test.
  if (status !== 'complete') throw new Error(`${block}: ${status}${reason ? `: ${reason}` : ''}`);
  return { runId: cfg.runId, block, pid: pf?.pid ?? null, startedAt, status };
}

/** Questions spoken so far in the run (every block's progress, not-run excluded). */
export function questionsSpoken(cfg: DriverConfig): number {
  if (!existsSync(cfg.out)) return 0;
  return readdirSync(cfg.out)
    .filter((f) => f.endsWith('-progress.jsonl'))
    .flatMap((f) => readLines<Progress>(join(cfg.out, f)))
    .filter((x) => !x.notRun).length;
}
