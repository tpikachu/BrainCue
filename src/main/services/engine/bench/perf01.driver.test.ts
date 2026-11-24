import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Row } from '../metrics/report';
import { DEFAULT_CAPS } from './perf01.budget';
import { bindRun, configFromEnv, paths, pinReference, runBlock, seedRun, type AppPort, type DriverConfig, type WatchState } from './perf01.driver';
import { fixtureText, REFERENCE, type BlockLog, type SampleLine } from './perf01.evidence';
import { GENERAL } from './perf01.fixtures';

/**
 * The live driver (perf01.driver.ts), OFFLINE: the real `runBlock`,
 * `seedRun` and `bindRun`, with real files in a temporary results folder.
 * Only the app is faked (`AppPort`), with a virtual clock. The fake app does
 * what the real one does at its edge:
 * - it writes latency records to <userData>/metrics/latency.jsonl when a take
 *   finishes;
 * - it announces takes and contexts to the watched Cue Card state;
 * - it keeps the meter's ledger and window snapshot, as live-meter.cjs does.
 */

const PID = 4321;
let out = '';
let userData = '';
let cfg: DriverConfig;

const wav = () => {
  const data = Buffer.alloc(24000 * 2 * 2); // 2 s of silence
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

type Script = (id: string, at: number, app: FakeApp) => void;

/** The fake app: a virtual clock, scheduled events, the files the real app writes. */
class FakeApp implements AppPort {
  t = Date.now();
  calls: string[] = [];
  streamed: { id: string; at: number }[] = [];
  state: WatchState = { questions: {}, contexts: {} };
  private events: { at: number; run: () => void }[] = [];
  effectiveAnswer: string = REFERENCE.answerModel;
  fast = false;
  installedCaps = { tokens: DEFAULT_CAPS.tokens, requests: DEFAULT_CAPS.requests, sttSeconds: DEFAULT_CAPS.sttSeconds };
  private take = 0;
  constructor(private script: Script) {}

  /** The meter's files, as live-meter.cjs keeps them for this process. */
  writeLedger() {
    const dir = paths(cfg).ledger;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'meter.json'),
      JSON.stringify({
        reservedTokens: 0,
        requests: 0,
        refused: 0,
        sttSeconds: 0,
        unboundedRequests: 0,
        byClass: {},
        models: {},
        capped: null,
        stt: { pid: PID, model: REFERENCE.sttModel, vad: 'server_vad', prefixPaddingMs: 300, silenceDurationMs: 600 },
        processes: [{ pid: PID, startedAt: this.t, caps: this.installedCaps }],
      }),
    );
    this.snapshot();
  }
  private snapshot() {
    writeFileSync(
      path.join(paths(cfg).ledger, 'windows.json'),
      JSON.stringify({
        at: this.t,
        pid: PID,
        displays: [
          { id: 1, primary: true },
          { id: 2, primary: false },
        ],
        windows: [
          { view: 'dashboard', visible: true, minimized: false, onPrimary: false },
          { view: 'overlay', visible: true, minimized: false, onPrimary: false },
        ],
      }),
    );
  }
  at(dt: number, run: () => void) {
    this.events.push({ at: this.t + dt, run });
  }
  private advance(to: number) {
    for (;;) {
      this.events.sort((a, b) => a.at - b.at);
      const e = this.events[0];
      if (!e || e.at > to) break;
      this.events.shift();
      this.t = Math.max(this.t, e.at);
      e.run();
    }
    this.t = to;
    if (existsSync(paths(cfg).ledger)) this.snapshot();
  }
  // ---- what the real app does, at its edge ----
  detect(qid: string, text: string) {
    this.state.questions[qid] = { ...this.state.questions[qid], id: qid, text, at: this.t };
  }
  /** A take starts: announced to the Cue Card, its context patched. Returns its number. */
  begin(qid: string, ctx: string) {
    const take = ++this.take;
    this.state.questions[qid].take = take;
    (this.state.contexts[qid] ??= {})[String(take)] = { chunks: [ctx] };
    return take;
  }
  /** A take finishes: its record is written. */
  finish(qid: string, take: number, over: Partial<Row> = {}) {
    const file = path.join(userData, 'metrics', 'latency.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    const finalAt = this.state.questions[qid].at!;
    const row: Row = {
      questionId: qid,
      sessionId: 's1',
      take,
      category: 'general',
      cold: true,
      finalAt,
      decidedAt: finalAt + 10,
      firstUsefulAt: this.t,
      completedAt: this.t + 500,
      outcome: 'answered',
      provider: 'openai',
      model: REFERENCE.answerModel,
      effort: REFERENCE.effort,
      promptTokens: 2_000,
      completionTokens: 200,
      ...(this.fast ? { requestedServiceTier: 'priority', serviceTier: 'fast' } : {}),
      ...over,
    };
    appendFileSync(file, JSON.stringify(row) + '\n');
  }
  // ---- AppPort ----
  setApiKey = async () => void this.calls.push('setApiKey');
  settingsSet = async (patch: Record<string, unknown>) => { this.calls.push('settingsSet'); this.fast = patch.openaiInterviewFast === true; };
  setUp = async () => (this.calls.push('setUp'), { profileId: 'p1', packId: 'k1' });
  startSession = async () => (this.calls.push('startSession'), 's1');
  stopSession = async () => void this.calls.push('stopSession');
  stream = async (_sid: string, b64: string) => {
    const id = this.nextId();
    this.calls.push(`stream:${id}`);
    this.streamed.push({ id, at: this.t });
    const ends = this.t + (Buffer.from(b64, 'base64').length / 48_000) * 1000 + 1_500;
    this.advance(ends);
    this.script(id, this.t, this);
  };
  ids: string[] = [];
  private nextId() {
    return this.ids[this.streamed.length];
  }
  watch = async () => void this.calls.push('watch');
  watched = async () => JSON.parse(JSON.stringify(this.state)) as WatchState;
  settings = async () => ({ effectiveModels: { answer: this.effectiveAnswer, classify: REFERENCE.classifyModel }, stt: { engine: 'cloud' }, sttReady: true, memoryEnabled: true, reasoningEfforts: {}, openaiInterviewFast: this.fast });
  readiness = async () => ({ chat: { ready: true, provider: 'openai' }, routes: { answer: 'openai', classify: 'openai', parsing: 'openai' }, retrieval: { mode: 'embeddings' }, transcription: { engine: 'cloud' } });
  profiles = async () => [{ id: 'p1' }];
  overlayVisibility = async () => 'visible';
  latencySummary = async () => ({ summary: { decisions: { n: 3, p50: 10, p95: 20 } }, samples: 2, hardware: { cpu: 'Fake CPU', cores: 4, memoryGb: 16, platform: 'test' } });
  wait = async (ms: number) => this.advance(this.t + ms);
  now = () => this.t;
}

/** The usual answer to a fixture: detected 0.5 s after its audio, answered 1.2 s later. */
const answers: Script = (id, _at, app) => {
  app.at(500, () => {
    app.detect(`q-${id}`, fixtureText(id));
    const take = app.begin(`q-${id}`, contextFor(id));
    app.at(1_200, () => app.finish(`q-${id}`, take));
  });
};
const FACT = new Map(GENERAL.map((q) => [q.id, q.fact]));
const contextFor = (id: string) => `context holding ${FACT.get(id) ?? 'the warm-up'}`;

const rows = (): SampleLine[] => readFileSync(paths(cfg).rows, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const blocks = (): BlockLog[] => readFileSync(paths(cfg).blocks, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), 'perf01-driver-'));
  userData = path.join(out, 'block-userData');
  cfg = { out: path.join(out, 'run'), runId: 'run', dry: false, caps: { ...DEFAULT_CAPS }, questionTimeoutMs: 30_000, settleMs: 30_000, gapMs: 1_000 };
  bindRun(cfg, { commit: 'abc', dirty: 0 });
  mkdirSync(paths(cfg).audio, { recursive: true });
  for (const id of ['W00', ...GENERAL.map((q) => q.id), 'T01', 'T05']) writeFileSync(path.join(paths(cfg).audio, `${id}.wav`), wav());
  writeFileSync(paths(cfg).seedIds, JSON.stringify({ profileId: 'p1', packId: 'k1', pid: 1111 }));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

function app(script: Script, ids: string[]) {
  const a = new FakeApp(script);
  a.ids = ids;
  a.writeLedger();
  return a;
}

describe('PERF-01 driver: a failed preflight fails, and ends the run (review of 492a6cc, finding 1)', () => {
  it('Fast is explicit in configuration and pinning; an unbound mode cannot send audio', async () => {
    expect(configFromEnv({ PERF01_PROCESSING: 'fast' }).processing).toBe('fast');
    expect(configFromEnv({}).processing).toBe('fast');
    expect(configFromEnv({ PERF01_PROCESSING: 'default' }).processing).toBeUndefined();
    expect(() => configFromEnv({ PERF01_PROCESSING: 'typo' })).toThrow(/must be default or fast/);
    const a = app(answers, ['G01']);
    await pinReference(a, { processing: 'fast' });
    expect((await a.settings()).openaiInterviewFast).toBe(true);
    cfg.processing = 'fast'; // the previously bound manifest was provider-default
    await expect(runBlock(a, cfg, 'cold-1', userData)).rejects.toThrow(/processing configuration matches the manifest/);
    expect(a.streamed).toEqual([]);
    await pinReference(a, {});
    expect((await a.settings()).openaiInterviewFast).toBe(false);
  });

  it('pins Fast again in each fresh block instead of undoing the seed setting', async () => {
    const seed = readFileSync(paths(cfg).seedIds);
    cfg = { ...cfg, out: path.join(out, 'fast-run'), runId: 'fast-run', processing: 'fast' };
    bindRun(cfg, { commit: 'abc', dirty: 0 });
    mkdirSync(paths(cfg).audio, { recursive: true });
    writeFileSync(path.join(paths(cfg).audio, 'G01.wav'), wav());
    writeFileSync(paths(cfg).seedIds, seed);
    const a = app(answers, ['G01']);
    await expect(runBlock(a, cfg, 'cold-1', userData)).resolves.toMatchObject({ status: 'complete' });
    expect(a.fast).toBe(true);
    expect(rows()).toEqual([expect.objectContaining({ fixtureId: 'G01', requestedServiceTier: 'priority', serviceTier: 'fast' })]);
  });

  it('a wrong effective answer model: evidence saved, session stopped, the block REJECTS, and no later block starts', async () => {
    const a = app(answers, ['G01']);
    a.effectiveAnswer = 'gpt-4.1-mini';
    await expect(runBlock(a, cfg, 'cold-1', userData)).rejects.toThrow(/cold-1: preflight-failed: answers route to gpt-6-luna \(effective: gpt-4\.1-mini\)/);
    expect(a.calls.filter((c) => c === 'stopSession')).toHaveLength(1);
    expect(a.calls.some((c) => c.startsWith('stream:'))).toBe(false); // no speech sent
    expect(blocks().at(-1)).toMatchObject({ block: 'cold-1', status: 'preflight-failed' });
    expect(rows()).toEqual([expect.objectContaining({ fixtureId: 'G01', outcome: 'not-run', reason: expect.stringMatching(/^preflight failed/) })]);
    // The next block of the run refuses to start: nothing is spent.
    const b = app(answers, ['G07']);
    await expect(runBlock(b, cfg, 'cold-2', userData)).rejects.toThrow(/cold-2: not started — the run stopped at cold-1 \(preflight-failed/);
    expect(b.calls).toEqual([]);
  });

  it('caps the meter installed that differ from the manifest: the block fails before any audio', async () => {
    const a = app(answers, ['G01']);
    a.installedCaps = { ...a.installedCaps, tokens: 10_000_000 };
    a.writeLedger();
    await expect(runBlock(a, cfg, 'cold-1', userData)).rejects.toThrow(/preflight-failed: the meter installed caps .*"tokens":10000000.* the manifest says .*"tokens":673000/);
    expect(a.calls.some((c) => c.startsWith('stream:'))).toBe(false);
  });

  it('control: a passing preflight runs the block to completion, and its sample is saved with its take’s grounding', async () => {
    const a = app(answers, ['G01']);
    const log = await runBlock(a, cfg, 'cold-1', userData);
    expect(log.status).toBe('complete');
    const [line] = rows();
    expect(line).toMatchObject({ fixtureId: 'G01', questionId: 'q-G01', take: 1, outcome: 'answered', grounded: true, pid: PID, attribution: { how: 'text', fixtureId: 'G01' } });
  });
});

describe('PERF-01 driver: the saved sample is the current take, reconciled at the end (finding 2)', () => {
  it('take 1 answered, then a correction: take 2 is collected and saved — with ITS timing and grounding', async () => {
    const script: Script = (id, _at, app) => {
      app.at(500, () => {
        app.detect('q1', fixtureText(id));
        const t1 = app.begin('q1', 'old wording context, no fact');
        app.at(1_000, () => {
          app.finish('q1', t1); // take 1: answered (and fast)
          app.at(200, () => {
            const t2 = app.begin('q1', contextFor(id)); // the correction starts take 2
            app.at(2_500, () => app.finish('q1', t2));
          });
        });
      });
    };
    const a = app(script, ['G01']);
    await runBlock(a, cfg, 'cold-1', userData);
    const [line] = rows();
    expect(line).toMatchObject({ fixtureId: 'G01', questionId: 'q1', take: 2, outcome: 'answered', grounded: true });
    // Take 2's own paint, not take 1's.
    expect(line.firstUsefulAt! - line.askedAt).toBeGreaterThan(4_000);
    const raw = readFileSync(path.join(cfg.out, 'cold-1-latency.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(2); // both takes are kept raw
  });

  it('a replacement that starts and finishes during the gap after collection: the reconciled line is take 2', async () => {
    const script: Script = (id, _at, app) => {
      app.at(500, () => {
        app.detect('q1', fixtureText(id));
        const t1 = app.begin('q1', 'old wording context, no fact');
        app.at(1_000, () => {
          app.finish('q1', t1);
          // Long after take 1 was collected (polls are every 250 ms), still inside the block.
          app.at(600, () => {
            const t2 = app.begin('q1', contextFor(id));
            app.at(300, () => app.finish('q1', t2));
          });
        });
      });
    };
    const a = app(script, ['G01']);
    await runBlock(a, cfg, 'cold-1', userData);
    const progress = readFileSync(path.join(cfg.out, 'cold-1-progress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(progress[0].provisional).toMatchObject({ questionId: 'q1', take: 1 }); // what the loop saw then
    expect(rows()[0]).toMatchObject({ take: 2, grounded: true }); // what was saved
  });

  it('a replacement still running at the end of the block: the block stops, and the fixture is saved as unanswered', async () => {
    const script: Script = (id, _at, app) => {
      app.at(500, () => {
        app.detect('q1', fixtureText(id));
        const t1 = app.begin('q1', 'ctx');
        app.at(1_000, () => {
          app.finish('q1', t1);
          app.at(100, () => app.begin('q1', 'ctx 2')); // take 2 never finishes
        });
      });
    };
    const a = app(script, ['G01']);
    await expect(runBlock(a, cfg, 'cold-1', userData)).rejects.toThrow(/cold-1: stopped: an answer was still in flight at the end of the block \(q1\)/);
    expect(rows()[0]).toMatchObject({ fixtureId: 'G01', outcome: 'no-record', reason: 'the current take (2) of its question never finished' });
  });

  it('the next fixture is not sent while a replacement of the previous one is still running', async () => {
    const ids = ['W00', ...GENERAL.map((q) => q.id)];
    let replacementDoneAt = 0;
    const script: Script = (id, at, app) => {
      if (id !== 'G01') return answers(id, at, app);
      app.at(500, () => {
        app.detect('qG01', fixtureText(id));
        const t1 = app.begin('qG01', 'ctx');
        app.at(1_000, () => {
          app.finish('qG01', t1);
          app.at(100, () => {
            const t2 = app.begin('qG01', contextFor(id));
            // Finishes well after the 1 s gap would have sent G02.
            app.at(8_000, () => {
              replacementDoneAt = app.t;
              app.finish('qG01', t2);
            });
          });
        });
      });
    };
    const a = app(script, ids);
    await runBlock(a, cfg, 'warm-general', userData);
    const g02 = a.streamed.find((s) => s.id === 'G02')!;
    expect(replacementDoneAt).toBeGreaterThan(0);
    expect(g02.at).toBeGreaterThanOrEqual(replacementDoneAt);
    expect(rows().find((l) => l.fixtureId === 'G01')).toMatchObject({ take: expect.any(Number), grounded: true, questionId: 'qG01' });
    expect(rows().filter((l) => l.block === 'warm-general')).toHaveLength(31);
  });
});

describe('PERF-01 driver: one run, one configuration (finding 3)', () => {
  it('a folder that already holds a manifest is refused — new caps cannot join an old run', () => {
    expect(() => bindRun({ ...cfg, caps: { ...cfg.caps, tokens: 1 } }, { commit: 'abc', dirty: 0 })).toThrow(/already holds a run/);
  });

  it('the seed spends nothing unless the meter installed the manifest’s caps', async () => {
    const a = app(answers, []);
    a.installedCaps = { ...a.installedCaps, requests: 1 };
    a.writeLedger();
    await expect(seedRun(a, cfg, a.t)).rejects.toThrow(/seed: not bound to the manifest/);
    expect(a.calls).toEqual([]);
    const ok = app(answers, []);
    await expect(seedRun(ok, cfg, ok.t)).resolves.toMatchObject({ profileId: 'p1', pid: PID });
  });
});
