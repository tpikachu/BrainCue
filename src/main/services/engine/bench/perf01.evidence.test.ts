import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from './perf01.budget';
import { liveReport, planRun, REFERENCE, validateEvidence, type BlockLog, type BlockSummaryFile, type Evidence, type MeterState, type PlannedBlock, type RequestLogEntry, type SampleLine } from './perf01.evidence';

/** The caps a real run installs (the driver's defaults), within which the control stays. */
const CAPS = { ...DEFAULT_CAPS, questionTimeoutMs: 30_000, settleMs: 30_000, gapMs: 15_000 };
const METER_CAPS = { tokens: CAPS.tokens, requests: CAPS.requests, sttSeconds: CAPS.sttSeconds };

/** A complete, valid live run: every planned block, every fixture once, the
 *  meter loaded in the seed's and every block's process with the manifest's
 *  caps, its totals within them, and its ledger matching its request log. */
function completeRun(): Evidence {
  const manifest = planRun({ runId: 'run-1', commit: 'abc1234', dirty: 0, caps: { ...CAPS }, dry: false, now: new Date(0) });
  const blocks: BlockLog[] = [];
  const lines: SampleLine[] = [];
  const summaries: BlockSummaryFile[] = [];
  let pid = 1000;
  const line = (b: PlannedBlock, id: string, p: number, cold: boolean): SampleLine => ({
    runId: 'run-1',
    block: b.block,
    fixtureId: id,
    pid: p,
    askedAt: 0,
    grounded: true,
    attribution: { questionId: `${b.block}-${id}`, take: 1, finalAt: 0, fixtureId: id, how: 'text', score: 1, late: false },
    questionId: `${b.block}-${id}`,
    sessionId: b.block,
    take: 1,
    category: b.category,
    cold,
    finalAt: 0,
    decidedAt: 20,
    firstUsefulAt: 1_000,
    outcome: 'answered',
    provider: 'openai',
    model: 'gpt-6-luna',
    effort: REFERENCE.effort,
  });
  for (const b of manifest.blocks) {
    const p = ++pid;
    blocks.push({ runId: 'run-1', block: b.block, pid: p, startedAt: 0, status: 'started' });
    blocks.push({ runId: 'run-1', block: b.block, pid: p, startedAt: 0, endedAt: 1, status: 'complete', preflight: { ok: true, failures: [], checks: {} } });
    if (b.warmup) lines.push(line(b, b.warmup, p, true));
    for (const id of b.fixtures) lines.push(line(b, id, p, b.kind === 'cold'));
    if (b.kind === 'warm') summaries.push({ runId: 'run-1', block: b.block, pid: p, summary: { decisions: { n: 40, p50: 300, p95: 900 } } });
  }
  // 400 sent requests of 750 reserved tokens each: 300,000, within 673,000.
  const requests: RequestLogEntry[] = Array.from({ length: 400 }, (_, i) => ({ at: i, pid: 1000, via: 'https', cls: i % 2 ? 'embedding' : 'responses', reservedPromptTokens: 600, reservedCompletionTokens: 150, sent: true }));
  const pids = [1000, ...blocks.filter((b) => b.status === 'complete').map((b) => b.pid!)];
  const meter: MeterState = {
    reservedTokens: 300_000,
    requests: 400,
    refused: 0,
    sttSeconds: 420,
    unboundedRequests: 0,
    byClass: { responses: 200, embedding: 190, 'realtime-connect': 12 },
    models: { 'gpt-6-luna': 200, 'text-embedding-3-small': 190 },
    stt: { model: 'gpt-4o-transcribe', vad: 'server_vad', prefixPaddingMs: 300, silenceDurationMs: 600 },
    capped: null,
    processes: pids.map((pid, i) => ({ pid, startedAt: i, caps: { ...METER_CAPS } })),
  };
  return { manifest, seed: { profileId: 'p', packId: 'k', pid: 1000 }, requests, lines, blocks, summaries, meter };
}

const codes = (e: Evidence) => validateEvidence(e).issues.map((i) => i.code);

describe('PERF-01 live evidence check', () => {
  it('reads the real metrics IPC envelope, retaining its all-turn decision summary', () => {
    const e = completeRun();
    for (const s of e.summaries) s.summary = JSON.parse(JSON.stringify({ summary: s.summary, samples: 31, hardware: { cpu: 'Synthetic CPU', cores: 4, memoryGb: 16, platform: 'test' } }));
    const v = validateEvidence(e);
    expect(v.issues).toEqual([]);
    expect(v.decisionsAllTurns).toMatchObject({ n: 40, p50: 300, p95: 900 }); // the worst warm block, not an invented merged percentile
  });

  it('rejects missing/empty nested decision data rather than inventing it from question records', () => {
    const e = completeRun();
    for (const s of e.summaries) s.summary = JSON.parse(JSON.stringify({ summary: { decisions: { n: 0, p50: null, p95: null } }, samples: 31 }));
    expect(validateEvidence(e).issues.map(i => i.code)).toContain('decision-evidence-missing');
  });

  it('rejects incomplete and ambiguous all-turn summaries', () => {
    for (const payload of [
      { summary: { decisions: { n: 1, p50: 10, p95: 20 } } },
      { decisions: { n: 40, p50: 300, p95: 900 }, summary: { decisions: { n: 40, p50: 10, p95: 20 } } },
      { summary: { decisions: { n: 40 } } },
    ]) {
      const e = completeRun();
      e.summaries[0].summary = JSON.parse(JSON.stringify(payload));
      expect(validateEvidence(e).issues.map(i => i.code)).toContain('decision-evidence-missing');
    }
  });

  it('control: a complete run is valid, and only then can its verdicts read "met"', () => {
    const e = completeRun();
    const v = validateEvidence(e);
    expect(v.issues).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.samples).toHaveLength(70); // 30 + 30 warm, 10 cold; warm-ups are not samples
    const { report, markdown } = liveReport(e);
    expect(report.verdicts.general).toEqual({ samples: 'met', usefulP50: 'met', usefulP95: 'met', cold: 'met' });
    expect(report.verdicts.technical).toEqual({ samples: 'met', usefulP50: 'met', usefulP95: 'met', cold: 'met' });
    expect(report.decision).toBe('met');
    expect(markdown).toMatch(/Live run, evidence validated/);
  });

  it('the review case: 30 × G01, 30 × T01, 5 cold rows each, 70 grounding failures, no decision summaries → invalid, never "met"', () => {
    const e = completeRun();
    const g01 = e.lines.find((l) => l.block === 'warm-general' && l.fixtureId === 'G01')!;
    const t01 = e.lines.find((l) => l.block === 'warm-technical' && l.fixtureId === 'T01')!;
    e.lines = [
      ...e.lines.filter((l) => l.fixtureId === 'W00'),
      ...Array.from({ length: 30 }, (_, i) => ({ ...g01, questionId: `g${i}`, grounded: false })),
      ...Array.from({ length: 30 }, (_, i) => ({ ...t01, questionId: `t${i}`, grounded: false })),
      ...e.lines.filter((l) => l.block.startsWith('cold')).map((l) => ({ ...l, grounded: false })),
    ];
    e.summaries = [];
    const v = validateEvidence(e);
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['fixture-duplicate', 'fixture-missing', 'grounding-miss', 'decision-evidence-missing']));
    expect(v.issues.find((i) => i.code === 'fixture-duplicate')!.detail).toMatch(/warm-general\/G01 ×30/);
    // Missing fixtures stay in the denominator, as unanswered.
    expect(v.samples.filter((s) => s.category === 'general' && !s.cold)).toHaveLength(30);
    expect(v.samples.filter((s) => s.outcome === 'missed')).toHaveLength(58);
    const { report, markdown } = liveReport(e);
    for (const c of ['general', 'technical'] as const) expect(Object.values(report.verdicts[c]).every((x) => x === 'invalid evidence' || x === 'insufficient samples')).toBe(true);
    expect(report.decision).toBe('invalid evidence'); // no fallback to question-only timings
    expect(markdown).toMatch(/^\*\*INVALID OR INCOMPLETE EVIDENCE/m);
    expect(markdown).not.toMatch(/\| met \|/);
  });

  it('a live report with no evidence check at all is invalid', () => {
    const { report } = liveReport({ manifest: null, seed: null, requests: [], lines: completeRun().lines, blocks: [], summaries: [], meter: null });
    expect(report.verdicts.general.usefulP50).not.toBe('met');
    expect(report.evidence?.issues[0].code).toBe('manifest-missing');
  });

  it('missing decision summaries alone make the decision verdict invalid, not a question-only "met"', () => {
    const e = completeRun();
    e.summaries = e.summaries.filter((s) => s.block !== 'warm-technical');
    expect(codes(e)).toEqual(['decision-evidence-missing']);
    expect(liveReport(e).report.decision).toBe('invalid evidence');
  });

  const cases: [string, (e: Evidence) => void, string][] = [
    ['a fixture never asked', (e) => (e.lines = e.lines.filter((l) => !(l.block === 'warm-general' && l.fixtureId === 'G17'))), 'fixture-missing'],
    ['a fixture in the wrong block', (e) => e.lines.push({ ...e.lines.find((l) => l.fixtureId === 'T03')!, block: 'warm-general' }), 'fixture-unplanned'],
    ['a recorded category that is not the block’s', (e) => (e.lines.find((l) => l.fixtureId === 'G05')!.category = 'technical'), 'category-mismatch'],
    ['two cold starts in one process', (e) => (e.blocks.filter((b) => b.block === 'cold-2').forEach((b) => (b.pid = e.blocks.find((x) => x.block === 'cold-1')!.pid)), e.lines.filter((l) => l.block === 'cold-2').forEach((l) => (l.pid = e.blocks.find((x) => x.block === 'cold-1')!.pid))), 'process-reused'],
    ['a cold sample that was not the process’s first answer', (e) => (e.lines.find((l) => l.block === 'cold-3')!.cold = false), 'cold-warm-mismatch'],
    ['another model answered', (e) => (e.lines.find((l) => l.fixtureId === 'G09')!.model = 'gpt-4.1-mini'), 'route-mismatch'],
    ['another effort', (e) => (e.lines.find((l) => l.fixtureId === 'T09')!.effort = 'low'), 'route-mismatch'],
    ['one grounding miss', (e) => (e.lines.find((l) => l.fixtureId === 'G21')!.grounded = false), 'grounding-miss'],
    ['a block that stopped', (e) => (e.blocks.filter((b) => b.block === 'warm-technical').at(-1)!.status = 'stopped'), 'block-incomplete'],
    ['a block that never ran', (e) => (e.blocks = e.blocks.filter((b) => b.block !== 'cold-10')), 'block-missing'],
    ['a failed preflight', (e) => (e.blocks.filter((b) => b.block === 'warm-general').at(-1)!.preflight = { ok: false, failures: ['overlay not visible'], checks: {} }), 'preflight-failed'],
    ['a row from another run', (e) => (e.lines.find((l) => l.fixtureId === 'G02')!.runId = 'run-0'), 'other-run'],
    ['the budget capped', (e) => (e.meter!.capped = { reason: 'tokens', cls: 'responses', at: 1 }), 'budget-capped'],
    ['an unexpected model on the wire', (e) => (e.meter!.models['gpt-6.1-terra'] = 1), 'model-unexpected'],
    ['another speech-to-text model', (e) => (e.meter!.stt!.model = 'gpt-4o-mini-transcribe'), 'stt-model'],
    ['no meter ledger', (e) => (e.meter = null), 'meter-missing'],
    ['a weak-text attribution', (e) => (e.lines.find((l) => l.fixtureId === 'G11')!.attribution!.how = 'window-weak-text'), 'attribution-weak'],
    ['a dry-run manifest', (e) => (e.manifest!.dry = true), 'dry-run'],
    // The meter bound to the manifest (review of 492a6cc, finding 3).
    ['reserved tokens over the manifest cap', (e) => (e.meter!.reservedTokens = CAPS.tokens + 1), 'over-cap'],
    ['requests over the manifest cap', (e) => (e.meter!.requests = CAPS.requests + 1), 'over-cap'],
    ['speech-to-text over the manifest cap', (e) => (e.meter!.sttSeconds = CAPS.sttSeconds + 1), 'over-cap'],
    ['more questions spoken than the cap', (e) => (e.manifest!.caps.questions = 71), 'over-cap'],
    ['a process that installed other caps', (e) => (e.meter!.processes[3].caps = { ...METER_CAPS, tokens: 10_000_000 }), 'caps-mismatch'],
    ['a process with no installed caps recorded', (e) => delete e.meter!.processes[2].caps, 'caps-mismatch'],
    ['a block process the meter never ran in', (e) => (e.meter!.processes = e.meter!.processes.filter((p) => p.pid !== e.blocks.find((b) => b.block === 'cold-4')!.pid)), 'meter-not-loaded'],
    ['a metered process that is no block of this run (a reused folder)', (e) => e.meter!.processes.push({ pid: 4242, startedAt: 9, caps: { ...METER_CAPS } }), 'process-unexpected'],
    ['a seed with no metered process', (e) => (e.seed!.pid = null), 'seed-unmetered'],
    ['a ledger that disagrees with its request log', (e) => e.requests.pop(), 'ledger-inconsistent'],
    ['a request refused (any reason)', (e) => e.requests.push({ at: 1, pid: 1000, via: 'socket', sent: false, refused: 'host-not-allowed' }), 'requests-refused'],
    ['a manifest with no caps', (e) => (e.manifest!.caps = {}), 'caps-missing'],
  ];
  it.each(cases)('invalid: %s', (_name, mutate, code) => {
    const e = completeRun();
    mutate(e);
    expect(codes(e)).toContain(code);
    const { report } = liveReport(e);
    expect(report.verdicts.general.usefulP50 === 'met' || report.verdicts.technical.usefulP50 === 'met').toBe(false);
  });

  it('the review case: a manifest capped at 1 token with a 300,000-token ledger is invalid, never "met"', () => {
    const e = completeRun();
    e.manifest!.caps = { ...e.manifest!.caps, tokens: 1 };
    const v = validateEvidence(e);
    expect(v.issues.map((i) => i.code)).toEqual(['over-cap', 'caps-mismatch']);
    expect(v.issues[0].detail).toBe('tokens 300000 > 1');
    const { report } = liveReport(e);
    expect(report.verdicts.general.usefulP50).toBe('invalid evidence');
    expect(report.decision).toBe('invalid evidence');
  });

  it('a no-record or not-run line is unanswered in the denominator (and not-run is flagged)', () => {
    const e = completeRun();
    const l = e.lines.find((x) => x.fixtureId === 'G30')!;
    Object.assign(l, { outcome: 'not-run', reason: 'budget', questionId: undefined });
    const v = validateEvidence(e);
    expect(v.issues.map((i) => i.code)).toEqual(['fixture-not-run']);
    expect(v.samples.find((s) => s.fixtureId === 'G30')).toMatchObject({ outcome: 'missed', reason: 'not run: budget' });
  });
});
