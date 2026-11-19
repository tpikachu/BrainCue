import { percentile, summarize, type LatencyCategory, type LatencySummary, type QuestionTiming, type StageSummary } from './latency';

/**
 * PERF-01 report (M7.2b): turns finished latency records — the rows of
 * `<userData>/metrics/latency.jsonl` from a live run, or the offline
 * benchmark's — into the acceptance view: per category, cold and warm, the
 * censored final → first useful paint p50/p95, every stage, outcomes, routes
 * and context sizes, judged against the targets.
 *
 * A SIMULATED report says so in its first line and never says "met": only a
 * live run on the reference configuration can meet a target.
 */

export const TARGETS = {
  warmUsefulP50Ms: 1500,
  warmUsefulP95Ms: 3000,
  decisionP95Ms: 1500,
  minWarmSamples: 30,
  minColdSamples: 5,
} as const;

/** A record plus the benchmark's own label for it (never in the app's file). */
export type Row = QuestionTiming & { fixtureId?: string };

export type Verdict = 'met' | 'not met' | 'insufficient samples' | 'simulated — not acceptance';

export interface Perf01Report {
  title: string;
  simulated: boolean;
  generatedAt: string;
  /** Anything the run wants on record: hardware, network/STT, config, KB size. */
  run: Record<string, unknown>;
  /** One sample per question: its latest take. Earlier takes are counted here. */
  superseded: number;
  summary: LatencySummary;
  /** Final → decision over the question records (the in-app summary also
   *  counts every non-question turn — see \`decisionsAllTurns\`). */
  decisionsQuestions: StageSummary;
  decisionsAllTurns?: StageSummary;
  verdicts: Record<'general' | 'technical', { usefulP50: Verdict; usefulP95: Verdict; samples: Verdict; cold: Verdict }>;
  decision: Verdict;
  routes: Record<string, number>;
  context: { chunks: StageSummary; memories: StageSummary; promptTokens: StageSummary; completionTokens: StageSummary; lexical: number };
  /** Every question that did not paint an answer, by id — never dropped. */
  unanswered: { id: string; category: LatencyCategory; outcome: string; reason?: string }[];
}

const stat = (vals: number[]): StageSummary => ({ n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95) });

/** The latest take of each question (take numbers only grow within a process). */
function latestTakes(rows: Row[]): { latest: Row[]; superseded: number } {
  const byQuestion = new Map<string, Row>();
  let superseded = 0;
  for (const r of rows) {
    if (r.outcome === 'superseded') {
      superseded++;
      continue;
    }
    const key = `${r.sessionId}\u0000${r.questionId}`;
    const prev = byQuestion.get(key);
    if (!prev || r.take > prev.take || (r.take === prev.take && (r.finalAt ?? 0) >= (prev.finalAt ?? 0))) byQuestion.set(key, r);
  }
  return { latest: [...byQuestion.values()], superseded };
}

export function buildReport(
  rows: Row[],
  opts: { simulated: boolean; title: string; run?: Record<string, unknown>; decisionsAllTurns?: StageSummary; now?: Date },
): Perf01Report {
  const { latest, superseded } = latestTakes(rows);
  const summary = summarize(latest, []);
  const decisionsQuestions = stat(
    latest.filter((r) => r.decidedAt !== undefined && r.decidedAt >= r.finalAt).map((r) => r.decidedAt! - r.finalAt),
  );
  const decisionBasis = opts.decisionsAllTurns ?? decisionsQuestions;
  const judge = (ok: boolean | null): Verdict => (opts.simulated ? 'simulated — not acceptance' : ok === null ? 'not met' : ok ? 'met' : 'not met');
  const verdicts = {} as Perf01Report['verdicts'];
  for (const c of ['general', 'technical'] as const) {
    const warm = summary.byCategory[c].warm;
    const cold = summary.byCategory[c].cold;
    const enough = warm.endToEnd.n >= TARGETS.minWarmSamples;
    verdicts[c] = {
      samples: enough ? (opts.simulated ? 'simulated — not acceptance' : 'met') : 'insufficient samples',
      usefulP50: enough ? judge(warm.endToEnd.p50 === null ? null : warm.endToEnd.p50 <= TARGETS.warmUsefulP50Ms) : 'insufficient samples',
      usefulP95: enough ? judge(warm.endToEnd.p95 === null ? null : warm.endToEnd.p95 <= TARGETS.warmUsefulP95Ms) : 'insufficient samples',
      cold: cold.samples >= TARGETS.minColdSamples ? (opts.simulated ? 'simulated — not acceptance' : 'met') : 'insufficient samples',
    };
  }
  const routes: Record<string, number> = {};
  for (const r of latest) {
    const key = r.provider ? `${r.provider}/${r.model ?? '?'} · effort ${r.effort ?? '?'}` : 'no route (never dispatched)';
    routes[key] = (routes[key] ?? 0) + 1;
  }
  const nums = (f: (r: Row) => number | undefined) => latest.map(f).filter((v): v is number => v !== undefined);
  return {
    title: opts.title,
    simulated: opts.simulated,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    run: opts.run ?? {},
    superseded,
    summary,
    decisionsQuestions,
    ...(opts.decisionsAllTurns ? { decisionsAllTurns: opts.decisionsAllTurns } : {}),
    verdicts,
    decision:
      decisionBasis.n === 0 ? 'insufficient samples' : judge(decisionBasis.p95 === null ? null : decisionBasis.p95 <= TARGETS.decisionP95Ms),
    routes,
    context: {
      chunks: stat(nums((r) => r.chunks)),
      memories: stat(nums((r) => r.memories)),
      promptTokens: stat(nums((r) => r.promptTokens)),
      completionTokens: stat(nums((r) => r.completionTokens)),
      lexical: latest.filter((r) => r.lexical?.length).length,
    },
    unanswered: latest
      .filter((r) => r.outcome !== 'answered' || r.firstUsefulAt === undefined)
      .map((r) => ({
        id: r.fixtureId ?? r.questionId,
        category: r.category,
        outcome: r.outcome === 'answered' ? 'answered, never painted' : (r.outcome ?? 'unfinished'),
        ...(r.reason ? { reason: r.reason } : {}),
      })),
  };
}

/** Parse a latency.jsonl file's text (blank lines and bad lines skipped and counted). */
export function parseJsonl(text: string): { rows: Row[]; skipped: number } {
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Row;
      // Older records (before categories/takes) default to general / take 0.
      if (typeof r.questionId === 'string' && typeof r.finalAt === 'number')
        rows.push({ ...r, category: r.category ?? 'general', take: r.take ?? 0 });
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v).toLocaleString('en-US')} ms`);

/** The report as Markdown — for the handoff and the evidence folder. */
export function renderMarkdown(r: Perf01Report): string {
  const out: string[] = [];
  out.push(`# ${r.title}`, '');
  out.push(
    r.simulated
      ? '**SIMULATED — offline latency model, simulated providers. Not live-provider evidence; no target is met by this report.**'
      : '**Live run.** Verdicts below are against the PERF-01 targets.',
    '',
  );
  out.push(`Generated ${r.generatedAt}.`, '');
  if (Object.keys(r.run).length) {
    out.push('## Run', '', '```json', JSON.stringify(r.run, null, 2), '```', '');
  }
  out.push('## Final → first useful paint (censored: an unanswered question counts as slower than any answer)', '');
  out.push('| Category | Split | n | unanswered | p50 | p95 | ≤ 1.5 s | ≤ 3 s |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of ['general', 'technical', 'coding'] as const)
    for (const split of ['warm', 'cold'] as const) {
      const e = r.summary.byCategory[c][split].endToEnd;
      if (c === 'coding' && e.n === 0) continue;
      out.push(`| ${c} | ${split} | ${e.n} | ${e.unanswered} | ${ms(e.p50)} | ${ms(e.p95)} | ${e.withinTarget.le1500} | ${e.withinTarget.le3000} |`);
    }
  out.push('', '## Verdicts', '', '| Category | warm n ≥ 30 | warm p50 ≤ 1.5 s | warm p95 ≤ 3 s | cold n ≥ 5 |', '| --- | --- | --- | --- | --- |');
  for (const c of ['general', 'technical'] as const) {
    const v = r.verdicts[c];
    out.push(`| ${c} | ${v.samples} | ${v.usefulP50} | ${v.usefulP95} | ${v.cold} |`);
  }
  const d = r.decisionsAllTurns ?? r.decisionsQuestions;
  out.push('', `Final → decision p95 ≤ 1.5 s: **${r.decision}** (${r.decisionsAllTurns ? 'every evaluated turn' : 'question records only'}: n ${d.n}, p50 ${ms(d.p50)}, p95 ${ms(d.p95)}).`, '');
  out.push('## Stages (warm, p50 / p95)', '', '| Stage | general | technical |', '| --- | --- | --- |');
  for (const stage of Object.keys(r.summary.byCategory.all.warm.stages) as (keyof typeof r.summary.byCategory.all.warm.stages)[]) {
    const g = r.summary.byCategory.general.warm.stages[stage];
    const t = r.summary.byCategory.technical.warm.stages[stage];
    out.push(`| ${stage} | ${ms(g.p50)} / ${ms(g.p95)} (n ${g.n}) | ${ms(t.p50)} / ${ms(t.p95)} (n ${t.n}) |`);
  }
  out.push('', '## Outcomes', '', '| Category | answered | empty | failed | aborted | missed |', '| --- | --- | --- | --- | --- | --- |');
  for (const c of ['general', 'technical', 'coding'] as const) {
    const o = r.summary.byCategory[c].all.outcomes;
    out.push(`| ${c} | ${o.answered} | ${o.empty} | ${o.failed} | ${o.aborted} | ${o.missed} |`);
  }
  out.push('', `Superseded earlier takes (not samples): ${r.superseded}.`, '');
  out.push('## Routes', '', ...Object.entries(r.routes).map(([k, n]) => `- ${k}: ${n}`), '');
  const c = r.context;
  out.push(
    '## Context sizes (p50 / p95)',
    '',
    `- chunks: ${c.chunks.p50 ?? '—'} / ${c.chunks.p95 ?? '—'}; memories: ${c.memories.p50 ?? '—'} / ${c.memories.p95 ?? '—'}`,
    `- prompt tokens: ${c.promptTokens.p50 ?? '—'} / ${c.promptTokens.p95 ?? '—'}; completion tokens: ${c.completionTokens.p50 ?? '—'} / ${c.completionTokens.p95 ?? '—'}`,
    `- answers grounded lexically after a late embedding: ${c.lexical}`,
    '',
  );
  out.push('## Unanswered or unpainted', '');
  out.push(...(r.unanswered.length ? r.unanswered.map((u) => `- ${u.id} (${u.category}): ${u.outcome}${u.reason ? ` — ${u.reason}` : ''}`) : ['- none']), '');
  return out.join('\n');
}
