import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, hasKey, setApiKey, type Page } from './fixtures';
import { GENERAL, MEMORIES, PERF01_VERSION, PROFILE, SPACE, TECHNICAL, type Question } from '../src/main/services/engine/bench/perf01.fixtures';

/**
 * PERF-01 LIVE DRIVER (M7.2b) — prepared, NOT yet run. Runs only with
 * PERF01_LIVE=1 and a key, under the live config (`npm run test:e2e:live`).
 * It sends the SYNTHETIC fixture data (perf01.fixtures.ts) to the configured
 * provider and costs money. Plan, caps and commands: docs/benchmarks/
 * PERF01-LIVE-PLAN.md. Never run it without that plan approved.
 *
 * The real app, the real pipeline: each question is synthesized locally to
 * speech (scripts/perf01/make-audio.ps1, no network, no device) and streamed
 * through the app's own audio IPC (`session.sendRealtimeAudio`) at real-time
 * pace, so speech end → final is real speech-to-text. No microphone, call
 * audio or screen capture is opened. Timing comes from the app's own
 * latency record (<userData>/metrics/latency.jsonl), read after every
 * question and labelled with its fixture id here.
 *
 * PERF01_DRY=1 checks the driver itself OFFLINE (the offline guard refuses
 * every request): the synthetic profile, Space and audio, the PCM framing —
 * and stops before a session starts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const LIVE = process.env.PERF01_LIVE === '1';
const DRY = process.env.PERF01_DRY === '1';
const OUT = resolve(process.env.PERF01_OUT || join('bench-results', 'perf01', `live-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const CAPS = {
  maxQuestions: Number(process.env.PERF01_MAX_QUESTIONS || 80), // 2 × (1 warm-up + 30) + 10 cold + margin
  maxTokens: Number(process.env.PERF01_MAX_TOKENS || 400_000), // prompt + completion, summed from the records
  maxFailures: Number(process.env.PERF01_MAX_FAILURES || 5), // per block, then the block stops
  questionTimeoutMs: Number(process.env.PERF01_QUESTION_TIMEOUT_MS || 30_000),
  gapMs: Number(process.env.PERF01_GAP_MS || 15_000), // between questions (an interview has pauses)
};
const FRAME_MS = 100;
const TAIL_SILENCE_MS = 1500; // lets the server VAD end the turn
const WARMUP: Question = { id: 'W00', category: 'general', text: 'Could you start by telling me a little about yourself?', fact: '', source: 'resume' };
/** Five cold starts per category: each in a fresh app process. */
const COLD: Question[] = [GENERAL[0], GENERAL[6], GENERAL[17], GENERAL[11], GENERAL[2], TECHNICAL[0], TECHNICAL[4], TECHNICAL[9], TECHNICAL[15], TECHNICAL[21]];

let asked = 0;
let tokens = 0;

function audioFor(questions: Question[]): Record<string, string> {
  const dir = join(OUT, 'audio');
  mkdirSync(dir, { recursive: true });
  const missing = questions.filter((q) => !existsSync(join(dir, `${q.id}.wav`)));
  if (missing.length) {
    const list = join(OUT, 'questions.json');
    writeFileSync(list, JSON.stringify(missing.map((q) => ({ id: q.id, text: q.text }))));
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/perf01/make-audio.ps1'), '-Questions', list, '-OutDir', dir], { stdio: 'inherit' });
  }
  return Object.fromEntries(questions.map((q) => [q.id, pcmOf(readFileSync(join(dir, `${q.id}.wav`))).toString('base64')]));
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

/** The synthetic profile, Space and memories, through the app's own IPC. */
async function setUp(page: Page, opts: { withMemories: boolean } = { withMemories: true }): Promise<{ profileId: string; packId: string }> {
  return page.evaluate(
    async ({ profile, space, memories, withMemories }) => {
      const api = (window as any).api;
      const p = await api.profiles.create({ name: profile.name, targetRole: profile.targetRole, targetCompany: profile.targetCompany, resumeText: profile.resumeText });
      await api.documents.reindexProfile(p.id);
      // Company research is normally scraped from a URL; here it rides with the JD.
      const { job } = await api.jobs.save({ profileId: p.id, kind: 'job', title: space.title, company: space.company, jdUrl: null, jdText: `${space.jdText}\n\n${space.companyResearch}`, companyUrl: null, notes: null });
      await api.settings.set({ memoryEnabled: true });
      // Approved memories need the embedding provider (not reachable offline).
      if (withMemories) for (const m of memories) await api.memory.create(p.id, m.content, { category: 'preference' });
      return { profileId: p.id as string, packId: (job as any).id as string };
    },
    { profile: PROFILE, space: SPACE, memories: MEMORIES, withMemories: opts.withMemories },
  );
}

function latencyRows(userData: string): any[] {
  const file = join(userData, 'metrics', 'latency.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** Stream one question's speech into the session at real-time pace, then
 *  wait for its latency record; label it and check its grounding. */
async function ask(page: Page, userData: string, sid: string, q: Question, pcm: string, block: string) {
  if (++asked > CAPS.maxQuestions) throw new Error(`question cap (${CAPS.maxQuestions}) reached`);
  if (tokens > CAPS.maxTokens) throw new Error(`token cap (${CAPS.maxTokens}) reached`);
  const before = latencyRows(userData).length;
  const askedAt = Date.now();
  await page.evaluate(
    async ({ sid, b64, frameMs, tailMs }) => {
      const api = (window as any).api;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const frame = (24000 * 2 * frameMs) / 1000;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const t0 = performance.now();
      let i = 0;
      const send = (chunk: Uint8Array) => api.session.sendRealtimeAudio(sid, chunk.slice().buffer, 'system');
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
    { sid, b64: pcm, frameMs: FRAME_MS, tailMs: TAIL_SILENCE_MS },
  );
  const deadline = Date.now() + CAPS.questionTimeoutMs;
  let rows = latencyRows(userData);
  while (rows.length === before && Date.now() < deadline) {
    await page.waitForTimeout(250);
    rows = latencyRows(userData);
  }
  const record = rows.length > before ? rows.at(-1) : null;
  const grounding = await page.evaluate((id) => (window as any).__perf01?.context?.[id] ?? null, record?.questionId);
  const grounded = q.fact ? !!grounding && JSON.stringify(grounding).includes(q.fact) : null;
  const line = record
    ? { ...record, fixtureId: q.id, block, askedAt, grounded }
    : { fixtureId: q.id, block, askedAt, outcome: 'no-record', reason: 'not detected or no record within the timeout' };
  appendFileSync(join(OUT, 'rows.jsonl'), JSON.stringify(line) + '\n');
  tokens += (record?.promptTokens ?? 0) + (record?.completionTokens ?? 0);
  await page.waitForTimeout(CAPS.gapMs);
  return line;
}

/** Keep each answer's grounding (the context the app shows as "data sent"). */
async function watchGrounding(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__perf01 = { context: {} };
    w.api.events.onContributionPatch((p: any) => {
      if (p.context) w.__perf01.context[p.contributionId] = { chunks: p.context.chunks?.map((c: any) => c.content), memories: p.context.memories?.map((m: any) => m.content) };
    });
  });
}

async function runBlock(page: Page, userData: string, block: string, format: 'general' | 'technical', questions: Question[], warmup: boolean) {
  const audio = audioFor(warmup ? [WARMUP, ...questions] : questions);
  await setApiKey(page);
  // The reference route (docs/benchmarks/PERF01-LIVE-PLAN.md): pinned, so a
  // discovery change mid-run cannot move it.
  await page.evaluate(() => (window as any).api.settings.set({ modelOverrides: { answer: 'gpt-6-luna', classify: 'gpt-6-luna' } }));
  const { profileId, packId } = await setUp(page);
  await watchGrounding(page);
  const session = await page.evaluate(({ p, k, f }) => (window as any).api.session.start(p, 'general', k, f, 'job'), { p: profileId, k: packId, f: format });
  const sid = (session as any).id ?? (session as any).session?.id;
  expect(sid, 'session started').toBeTruthy();
  let failures = 0;
  if (warmup) {
    const w = await ask(page, userData, sid, WARMUP, audio[WARMUP.id], block);
    // The Cue Card must be on screen: a hidden window does not paint.
    expect((w as any).firstUsefulAt, 'warm-up painted — is the Cue Card visible on the second screen?').toBeTruthy();
  }
  for (const q of questions) {
    const r = await ask(page, userData, sid, q, audio[q.id], block);
    if ((r as any).outcome !== 'answered' || !(r as any).firstUsefulAt) failures++;
    if (failures > CAPS.maxFailures) throw new Error(`${block}: more than ${CAPS.maxFailures} failed questions — stopped`);
  }
  const summary = await page.evaluate(() => (window as any).api.metrics.latency());
  writeFileSync(join(OUT, `${block}-summary.json`), JSON.stringify(summary, null, 2));
  // The app's own records, unlabelled, kept with the evidence (test-results/
  // — where the per-test user data lives — is cleared by the next run).
  const raw = join(userData, 'metrics', 'latency.jsonl');
  if (existsSync(raw)) writeFileSync(join(OUT, `${block}-latency.jsonl`), readFileSync(raw));
  await page.evaluate((id) => (window as any).api.session.stop(id), sid);
}

test.describe('PERF-01 live benchmark', () => {
  test.skip(!DRY && (!LIVE || !hasKey), 'Live PERF-01 runs only with PERF01_LIVE=1, a key, and the approved plan.');
  if (DRY) test.use({ live: false } as any); // offline: the guard refuses every request
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'run.json'), JSON.stringify({ fixtures: PERF01_VERSION, dry: DRY, caps: CAPS, startedAt: new Date().toISOString(), node: process.version, platform: process.platform }, null, 2));
  });

  test('dry run: synthetic data, audio and framing — no session, no provider', async ({ dashboard }) => {
    test.skip(!DRY, 'PERF01_DRY=1 only');
    const audio = audioFor([WARMUP, ...GENERAL, ...TECHNICAL]);
    for (const [id, b64] of Object.entries(audio)) {
      const seconds = Buffer.from(b64, 'base64').length / (24000 * 2);
      expect(seconds, `${id} has speech`).toBeGreaterThan(1);
      expect(seconds, `${id} is a short question`).toBeLessThan(10);
    }
    const ids = await setUp(dashboard, { withMemories: false }); // dry: no embedding provider
    expect(ids.profileId).toBeTruthy();
    expect(ids.packId).toBeTruthy();
    writeFileSync(join(OUT, 'dry.json'), JSON.stringify({ questions: Object.keys(audio).length, memoriesSkipped: true, ...ids }, null, 2));
  });

  test('warm General: one warm-up, then G01–G30', async ({ dashboard }, info) => {
    test.skip(DRY, 'live only');
    test.setTimeout(45 * 60_000);
    await runBlock(dashboard, resolve(info.outputDir, 'userData'), 'warm-general', 'general', GENERAL, true);
  });

  test('warm Technical: one warm-up, then T01–T30', async ({ dashboard }, info) => {
    test.skip(DRY, 'live only');
    test.setTimeout(45 * 60_000);
    await runBlock(dashboard, resolve(info.outputDir, 'userData'), 'warm-technical', 'technical', TECHNICAL, true);
  });

  // Each test is a fresh app process (its own user data), so its one
  // question is that process's first answer: a cold start.
  for (const [i, q] of COLD.entries()) {
    test(`cold start ${i + 1}: ${q.id} in a fresh process`, async ({ dashboard }, info) => {
      test.skip(DRY, 'live only');
      test.setTimeout(5 * 60_000);
      await runBlock(dashboard, resolve(info.outputDir, 'userData'), `cold-${i + 1}`, q.category, [q], false);
    });
  }
});
