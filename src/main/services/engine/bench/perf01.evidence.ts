import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
// Relative, not @shared: the Playwright driver imports this module too.
import { liveTaskEffort } from '../../../../shared/modelPolicy';
import type { StageSummary } from '../metrics/latency';
import { buildReport, renderMarkdown, type EvidenceCheck, type Perf01Report, type Row } from '../metrics/report';
import type { Attribution } from './perf01.collect';
import { GENERAL, PERF01_VERSION, TECHNICAL } from './perf01.fixtures';

/**
 * PERF-01 live evidence: the run's MANIFEST (what was planned), and the
 * check that the results match it before any verdict is given.
 *
 * Row counts are not evidence. A results folder is accepted only when:
 *
 * - every planned block ran to completion in its own app process;
 * - each planned fixture appears exactly once, in its block and category;
 * - each answer's context held its expected fact;
 * - each answer used the reference route and effort, including the
 *   speech-to-text and embedding models the meter saw;
 * - every warm block has its all-turn decision summary;
 * - the budget meter covered the whole run and never capped it.
 *
 * Anything else makes the evidence invalid. The report still shows the
 * measured latencies, labelled as diagnostics.
 */

export const WARMUP_ID = 'W00';
export const WARMUP_TEXT = 'Could you start by telling me a little about yourself?';

/** Five cold starts per category, each in a fresh app process. */
export const COLD_IDS = ['G01', 'G07', 'G18', 'G12', 'G03', 'T01', 'T05', 'T10', 'T16', 'T22'];

export const REFERENCE = {
  provider: 'openai',
  answerModel: 'gpt-6-luna',
  classifyModel: 'gpt-6-luna',
  parsingModel: 'gpt-6-luna',
  embeddingModel: 'text-embedding-3-small',
  sttModel: 'gpt-4o-transcribe',
  /** What the answer request sends for this model (shared/modelPolicy). */
  effort: liveTaskEffort('openai', 'gpt-6-luna'),
} as const;

export type Category = 'general' | 'technical';

export interface PlannedBlock {
  block: string;
  kind: 'warm' | 'cold';
  category: Category;
  /** The answer style the session runs with. */
  format: Category;
  /** The unmeasured first question (warm blocks only). */
  warmup: string | null;
  fixtures: string[];
}

export interface Manifest {
  runId: string;
  fixtures: string;
  dry: boolean;
  /** Explicit Fast request run; absent preserves the historical provider-default run. */
  processing?: 'fast';
  createdAt: string;
  commit: string;
  /** Uncommitted files in the tree when the run started. */
  dirty: number;
  caps: Record<string, number>;
  reference: typeof REFERENCE;
  blocks: PlannedBlock[];
}

const byId = new Map([...GENERAL, ...TECHNICAL].map((q) => [q.id, q]));
export const fixtureText = (id: string): string => (id === WARMUP_ID ? WARMUP_TEXT : (byId.get(id)?.text ?? ''));

export function planRun(p: { runId: string; commit: string; dirty: number; caps: Record<string, number>; dry: boolean; processing?: 'fast'; now?: Date }): Manifest {
  return {
    runId: p.runId,
    fixtures: PERF01_VERSION,
    dry: p.dry,
    ...(p.processing ? { processing: p.processing } : {}),
    createdAt: (p.now ?? new Date()).toISOString(),
    commit: p.commit,
    dirty: p.dirty,
    caps: p.caps,
    reference: REFERENCE,
    blocks: [
      { block: 'warm-general', kind: 'warm', category: 'general', format: 'general', warmup: WARMUP_ID, fixtures: GENERAL.map((q) => q.id) },
      { block: 'warm-technical', kind: 'warm', category: 'technical', format: 'technical', warmup: WARMUP_ID, fixtures: TECHNICAL.map((q) => q.id) },
      ...COLD_IDS.map((id, i): PlannedBlock => {
        const category = byId.get(id)!.category as Category;
        return { block: `cold-${i + 1}`, kind: 'cold', category, format: category, warmup: null, fixtures: [id] };
      }),
    ],
  };
}

/** The driver's per-block log line (blocks.jsonl). */
export interface BlockLog {
  runId: string;
  block: string;
  pid: number | null;
  startedAt: number;
  endedAt?: number;
  status: 'started' | 'complete' | 'stopped' | 'preflight-failed';
  reason?: string;
  preflight?: { ok: boolean; failures: string[]; checks: Record<string, unknown> };
}

/** One asked fixture (rows.jsonl): its sample record, if any, plus labels. */
export type SampleLine = Omit<Partial<Row>, 'outcome'> & {
  runId: string;
  block: string;
  fixtureId: string;
  pid: number | null;
  askedAt: number;
  audioEndAt?: number;
  attribution?: Attribution | null;
  /** The answer's context held the fixture's expected fact (null: not checkable). */
  grounded: boolean | null;
  /** `no-record`: nothing attributed within the timeout. `not-run`: the block stopped first. */
  outcome?: Row['outcome'] | 'no-record' | 'not-run';
};

export interface BlockSummaryFile {
  runId: string;
  block: string;
  pid: number | null;
  summary?: {
    /** Legacy direct summary from the old test AppPort. */
    decisions?: StageSummary;
    /** Real api.metrics.latency() snapshot returned by the preload bridge. */
    summary?: { decisions?: StageSummary };
    samples?: number;
    hardware?: unknown;
  };
}

/** The meter's ledger (scripts/perf01/meter-core.cjs). */
export interface MeterState {
  reservedTokens: number;
  requests: number;
  refused: number;
  sttSeconds: number;
  unboundedRequests: number;
  byClass: Record<string, number>;
  models: Record<string, number>;
  stt: { model: string | null; vad: string | null; prefixPaddingMs: number | null; silenceDurationMs: number | null } | null;
  capped: { reason: string; cls: string; at: number } | null;
  /** Every app process the meter was loaded in, with the caps it installed. */
  processes: { pid: number; startedAt: number; caps?: { tokens: number; requests: number; sttSeconds: number } }[];
}

/** One line of the meter's request log (ledger/requests.jsonl). */
export interface RequestLogEntry {
  at: number;
  pid: number;
  via: string;
  cls?: string;
  model?: string | null;
  reservedPromptTokens?: number;
  reservedCompletionTokens?: number;
  sent: boolean;
  refused?: string;
}

/** The caps a run installs in the meter, and how many questions it may speak. */
export const METER_CAP_KEYS = ['tokens', 'requests', 'sttSeconds'] as const;
export const RUN_CAP_KEYS = [...METER_CAP_KEYS, 'questions'] as const;

export interface Evidence {
  manifest: Manifest | null;
  /** seed.json: the seeded ids, and the seed's app process. */
  seed: { profileId: string; packId: string; pid: number | null } | null;
  requests: RequestLogEntry[];
  lines: SampleLine[];
  blocks: BlockLog[];
  summaries: BlockSummaryFile[];
  meter: MeterState | null;
}

export interface Validated extends EvidenceCheck {
  /** One sample per planned fixture (warm-ups excluded); missing ones as unanswered. */
  samples: Row[];
  /** The all-turn decision basis: the worst warm block's p95 (conservative). */
  decisionsAllTurns?: StageSummary;
  groundingMisses: string[];
}

const missedRow = (b: PlannedBlock, fixtureId: string, at: number, reason: string): Row => ({
  questionId: `missing:${b.block}:${fixtureId}`,
  sessionId: b.block,
  take: 0,
  category: b.category,
  cold: b.kind === 'cold',
  finalAt: at,
  outcome: 'missed',
  reason,
  fixtureId,
});

export function validateEvidence(e: Evidence): Validated {
  const issues: { code: string; detail: string }[] = [];
  const add = (code: string, ids: string[] | string) => {
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length) issues.push({ code, detail: list.length > 12 ? `${list.slice(0, 12).join(', ')} … (${list.length} in all)` : list.join(', ') });
  };
  const m = e.manifest;
  if (!m) {
    add('manifest-missing', 'no manifest.json: nothing to check the results against');
    return { valid: false, issues, samples: [], groundingMisses: [] };
  }
  if (m.dry) add('dry-run', 'the manifest is a dry run');
  if (m.processing !== undefined && m.processing !== 'fast') add('processing-changed', 'unknown processing mode');
  if (m.fixtures !== PERF01_VERSION) add('fixture-version', `manifest ${m.fixtures}, fixtures ${PERF01_VERSION}`);
  const ref = m.reference;
  if (JSON.stringify(ref) !== JSON.stringify(REFERENCE)) add('reference-changed', `manifest reference ${JSON.stringify(ref)}`);

  const otherRun = [...e.lines, ...e.blocks, ...e.summaries].filter((x) => x.runId !== m.runId).map((x) => ('fixtureId' in x ? `${x.block}/${x.fixtureId}` : x.block));
  add('other-run', otherRun);

  const planned = new Map(m.blocks.map((b) => [b.block, b]));
  add('block-unplanned', [...new Set([...e.lines, ...e.blocks].map((x) => x.block).filter((b) => !planned.has(b)))]);

  // Blocks: each completed, preflight passed, in its own process.
  const lastLog = new Map<string, BlockLog>();
  for (const l of e.blocks.filter((x) => x.runId === m.runId)) lastLog.set(l.block, l);
  const missingBlocks: string[] = [];
  const incomplete: string[] = [];
  const preflight: string[] = [];
  for (const b of m.blocks) {
    const log = lastLog.get(b.block);
    if (!log) missingBlocks.push(b.block);
    else {
      if (log.status !== 'complete') incomplete.push(`${b.block} (${log.status}${log.reason ? `: ${log.reason}` : ''})`);
      if (!log.preflight?.ok) preflight.push(`${b.block}${log.preflight ? `: ${log.preflight.failures.join('; ')}` : ': none recorded'}`);
    }
  }
  add('block-missing', missingBlocks);
  add('block-incomplete', incomplete);
  add('preflight-failed', preflight);
  const pids = new Map<number, string[]>();
  for (const b of m.blocks) {
    const pid = lastLog.get(b.block)?.pid;
    if (pid == null) continue;
    pids.set(pid, [...(pids.get(pid) ?? []), b.block]);
  }
  add('process-reused', [...pids.entries()].filter(([, bs]) => bs.length > 1).map(([pid, bs]) => `pid ${pid}: ${bs.join(' + ')}`));

  // Fixtures: once each, where planned.
  const samples: Row[] = [];
  const seen = new Map<string, SampleLine[]>();
  for (const l of e.lines.filter((x) => x.runId === m.runId && planned.has(x.block))) {
    const key = `${l.block}/${l.fixtureId}`;
    seen.set(key, [...(seen.get(key) ?? []), l]);
  }
  const unplannedFixture: string[] = [];
  for (const key of seen.keys()) {
    const [block, id] = key.split('/');
    const b = planned.get(block)!;
    if (id !== b.warmup && !b.fixtures.includes(id)) unplannedFixture.push(key);
  }
  add('fixture-unplanned', unplannedFixture);
  add('fixture-duplicate', [...seen.entries()].filter(([, ls]) => ls.length > 1).map(([k, ls]) => `${k} ×${ls.length}`));

  const missing: string[] = [];
  const notRun: string[] = [];
  const category: string[] = [];
  const coldness: string[] = [];
  const route: string[] = [];
  const processing: string[] = [];
  const grounding: string[] = [];
  const attributionWeak: string[] = [];
  const pidMismatch: string[] = [];
  for (const b of m.blocks) {
    const blockPid = lastLog.get(b.block)?.pid ?? null;
    for (const id of b.fixtures) {
      const key = `${b.block}/${id}`;
      const line = seen.get(key)?.[0];
      if (!line) {
        missing.push(key);
        samples.push(missedRow(b, id, 0, 'no line: never asked'));
        continue;
      }
      if (line.pid !== blockPid) pidMismatch.push(key);
      if (line.outcome === 'no-record' || line.outcome === 'not-run' || line.questionId === undefined) {
        if (line.outcome === 'not-run') notRun.push(key);
        samples.push(missedRow(b, id, line.askedAt, line.outcome === 'not-run' ? `not run: ${line.reason ?? 'the block stopped'}` : (line.reason ?? 'no record within the timeout')));
        continue;
      }
      const r = line as SampleLine & Row;
      if (r.category !== b.category) category.push(`${key} recorded ${r.category}`);
      if (b.kind === 'cold' && r.cold !== true) coldness.push(`${key} is not its process's first answer`);
      if (b.kind === 'warm' && r.cold !== false) coldness.push(`${key} recorded cold in a warm block`);
      if (r.outcome === 'answered') {
        const want = `${ref.provider}/${ref.answerModel}/${ref.effort}`;
        const got = `${r.provider}/${r.model}/${r.effort}`;
        if (got !== want) route.push(`${key} ${got}`);
        if (m.processing === 'fast' &&
            (r.requestedServiceTier !== 'priority' || !['fast', 'priority', 'default'].includes(r.serviceTier ?? '')))
          processing.push(`${key}: requested ${r.requestedServiceTier ?? 'unknown'}, used ${r.serviceTier ?? 'unknown'}`);
        if (r.grounded !== true) grounding.push(key);
      }
      if (line.attribution && line.attribution.how !== 'text' && line.attribution.how !== 'window') attributionWeak.push(`${key} (${line.attribution.how})`);
      samples.push({ ...r, fixtureId: id, outcome: r.outcome } as Row);
    }
  }
  add('fixture-missing', missing);
  add('fixture-not-run', notRun);
  add('category-mismatch', category);
  add('cold-warm-mismatch', coldness);
  add('route-mismatch', route);
  add('processing-evidence-missing', processing);
  add('grounding-miss', grounding);
  add('attribution-weak', attributionWeak);
  add('process-mismatch', pidMismatch);

  // Decision evidence: every warm block's all-turn summary.
  const decisions: StageSummary[] = [];
  const noDecisions: string[] = [];
  for (const b of m.blocks.filter((x) => x.kind === 'warm')) {
    const s = e.summaries.find((x) => x.runId === m.runId && x.block === b.block);
    const root = s?.summary;
    const ambiguous = !!root?.decisions && !!root?.summary;
    const d = root?.summary?.decisions ?? root?.decisions;
    const minimumTurns = b.fixtures.length + (b.warmup ? 1 : 0);
    if (!s || ambiguous || !d || !Number.isInteger(d.n) || d.n < minimumTurns ||
        typeof d.p50 !== 'number' || !Number.isFinite(d.p50) || d.p50 < 0 ||
        typeof d.p95 !== 'number' || !Number.isFinite(d.p95) || d.p95 < d.p50) noDecisions.push(b.block);
    else {
      if (s.pid !== (lastLog.get(b.block)?.pid ?? null)) noDecisions.push(`${b.block} (summary from another process)`);
      decisions.push(d);
    }
  }
  add('decision-evidence-missing', noDecisions);

  // The meter: present, never capped, only the reference models — and
  // bound to THIS manifest: its caps installed in every process of the run,
  // every total within them, and its ledger agreeing with its own log.
  const caps = m.caps ?? {};
  const missingCaps = RUN_CAP_KEYS.filter((k) => typeof caps[k] !== 'number');
  add('caps-missing', missingCaps.map((k) => `manifest has no ${k} cap`));
  if (!e.meter) add('meter-missing', 'no ledger: the budget and the models sent were not observed');
  else {
    if (e.meter.capped) add('budget-capped', `${e.meter.capped.reason} (${e.meter.capped.cls}): the run stopped short`);
    const over: string[] = [];
    if (typeof caps.tokens === 'number' && e.meter.reservedTokens > caps.tokens) over.push(`tokens ${e.meter.reservedTokens} > ${caps.tokens}`);
    if (typeof caps.requests === 'number' && e.meter.requests > caps.requests) over.push(`requests ${e.meter.requests} > ${caps.requests}`);
    if (typeof caps.sttSeconds === 'number' && e.meter.sttSeconds > caps.sttSeconds) over.push(`speech-to-text ${Math.round(e.meter.sttSeconds)} s > ${caps.sttSeconds} s`);
    const spoken = e.lines.filter((l) => l.runId === m.runId && l.outcome !== 'not-run').length;
    if (typeof caps.questions === 'number' && spoken > caps.questions) over.push(`questions ${spoken} > ${caps.questions}`);
    add('over-cap', over);
    // Installed caps: every process the meter ran in, the manifest's caps.
    add(
      'caps-mismatch',
      e.meter.processes
        .filter((p) => !p.caps || METER_CAP_KEYS.some((k) => p.caps![k] !== caps[k]))
        .map((p) => `pid ${p.pid} installed ${JSON.stringify(p.caps ?? null)}`),
    );
    // Coverage: the meter ran in exactly the seed's and the blocks' processes.
    const expected = new Set<number>([...(e.seed?.pid != null ? [e.seed.pid] : []), ...[...lastLog.values()].map((l) => l.pid).filter((p): p is number => p != null)]);
    if (!e.seed || e.seed.pid == null) add('seed-unmetered', 'seed.json names no metered process');
    const metered = new Set(e.meter.processes.map((p) => p.pid));
    add('meter-not-loaded', [...expected].filter((p) => !metered.has(p)).map((p) => `pid ${p}`));
    add('process-unexpected', [...metered].filter((p) => !expected.has(p)).map((p) => `pid ${p}`));
    // The ledger agrees with its own request log.
    const http = e.requests.filter((r) => r.sent && (r.via === 'http' || r.via === 'https' || r.via === 'fetch'));
    const logged = http.reduce((n, r) => n + (r.reservedPromptTokens ?? 0) + (r.reservedCompletionTokens ?? 0), 0);
    if (http.length !== e.meter.requests || logged !== e.meter.reservedTokens)
      add('ledger-inconsistent', `ledger ${e.meter.requests} requests / ${e.meter.reservedTokens} tokens, log ${http.length} / ${logged}`);
    // Anything refused: a cap, capture, or a host other than the provider.
    const refused = new Map<string, number>();
    for (const r of e.requests.filter((x) => !x.sent)) refused.set(r.refused ?? 'unknown', (refused.get(r.refused ?? 'unknown') ?? 0) + 1);
    add('requests-refused', [...refused.entries()].map(([why, n]) => `${why} ×${n}`));
    const allowed = new Set<string>([ref.answerModel, ref.classifyModel, ref.parsingModel, ref.embeddingModel]);
    add('model-unexpected', Object.keys(e.meter.models).filter((x) => !allowed.has(x)));
    if (e.meter.stt?.model !== ref.sttModel) add('stt-model', `speech-to-text ran ${e.meter.stt?.model ?? 'unobserved'}, reference ${ref.sttModel}`);
  }

  const worst = decisions.length && !noDecisions.length ? [...decisions].sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0] : undefined;
  return { valid: issues.length === 0, issues, samples, ...(worst ? { decisionsAllTurns: worst } : {}), groundingMisses: grounding };
}

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T) : null);
const readLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** Everything a results folder holds, as the driver wrote it. */
export function readEvidence(dir: string): Evidence {
  return {
    manifest: readJson<Manifest>(path.join(dir, 'manifest.json')),
    seed: readJson<Evidence['seed'] & object>(path.join(dir, 'seed.json')),
    requests: readLines<RequestLogEntry>(path.join(dir, 'ledger', 'requests.jsonl')),
    lines: readLines<SampleLine>(path.join(dir, 'rows.jsonl')),
    blocks: readLines<BlockLog>(path.join(dir, 'blocks.jsonl')),
    summaries: readdirSync(dir)
      .filter((f) => /-summary\.json$/.test(f))
      .map((f) => readJson<BlockSummaryFile>(path.join(dir, f))!)
      .filter(Boolean),
    meter: readJson<MeterState>(path.join(dir, 'ledger', 'meter.json')),
  };
}

/** The live report of a results folder: validated first, then judged. */
export function liveReport(e: Evidence, now?: Date): { report: Perf01Report; markdown: string; validated: Validated } {
  const v = validateEvidence(e);
  const report = buildReport(v.samples, {
    simulated: false,
    title: `PERF-01 live benchmark (${e.manifest?.fixtures ?? 'no manifest'})`,
    evidence: { valid: v.valid, issues: v.issues },
    ...(v.decisionsAllTurns ? { decisionsAllTurns: v.decisionsAllTurns } : {}),
    run: {
      runId: e.manifest?.runId,
      commit: e.manifest?.commit,
      dirtyFiles: e.manifest?.dirty,
      reference: e.manifest?.reference,
      processing: e.manifest?.processing ?? 'provider-default (actual tier unrecorded in older runs)',
      caps: e.manifest?.caps,
      budget: e.meter
        ? {
            reservedTokens: e.meter.reservedTokens,
            requests: e.meter.requests,
            refused: e.meter.refused,
            sttSeconds: Math.round(e.meter.sttSeconds),
            unboundedRequests: e.meter.unboundedRequests,
            byClass: e.meter.byClass,
            models: e.meter.models,
            stt: e.meter.stt,
            capped: e.meter.capped,
          }
        : null,
      groundingMisses: v.groundingMisses,
    },
    ...(now ? { now } : {}),
  });
  return { report, markdown: renderMarkdown(report), validated: v };
}
