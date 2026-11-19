import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown, type Row } from '../metrics/report';
import { GENERAL, PERF01_VERSION, TECHNICAL } from './perf01.fixtures';
import type { StageSummary } from '../metrics/latency';

/**
 * PERF-01 LIVE REPORT — turns a live driver's results folder
 * (e2e/live-perf01.spec.ts → bench-results/perf01/live-<stamp>/) into
 * report.md / report.json. Skipped unless PERF01_RESULTS names that folder:
 *
 *   $env:PERF01_RESULTS = 'bench-results\perf01\live-<stamp>'; npm run perf01:report
 *
 * Every fixture question is in the denominator: one with no record (not
 * detected, or nothing within the timeout) is counted as unanswered. The
 * warm-up (W00) is not a sample. Grounding misses are listed.
 */
const DIR = process.env.PERF01_RESULTS;
const fixture = new Map([...GENERAL, ...TECHNICAL].map((q) => [q.id, q]));

describe.skipIf(!DIR)('PERF-01 live report', () => {
  it('writes report.md and report.json', () => {
    const dir = path.resolve(DIR!);
    const lines = readFileSync(path.join(dir, 'rows.jsonl'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const rows: Row[] = lines
      .filter((l) => l.fixtureId !== 'W00')
      .map((l) =>
        l.outcome === 'no-record'
          ? ({
              questionId: `missing:${l.block}:${l.fixtureId}`,
              sessionId: l.block,
              take: 0,
              category: fixture.get(l.fixtureId)?.category ?? 'general',
              cold: String(l.block).startsWith('cold'),
              finalAt: l.askedAt,
              outcome: 'missed',
              reason: 'no record (not detected, or none within the timeout)',
              fixtureId: l.fixtureId,
            } as Row)
          : (l as Row),
      );
    const summaries = readdirSync(dir).filter((f) => /-summary\.json$/.test(f));
    const decisions: StageSummary[] = summaries
      .filter((f) => f.startsWith('warm-'))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')).summary?.decisions)
      .filter(Boolean);
    // Conservative: the worse warm block's p95.
    const worst = decisions.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0];
    const groundingMisses = lines.filter((l) => l.grounded === false).map((l) => l.fixtureId);
    const run = existsSync(path.join(dir, 'run.json')) ? JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) : {};
    const report = buildReport(rows, {
      simulated: false,
      title: `PERF-01 live benchmark (${PERF01_VERSION})`,
      run: { ...run, groundingMisses, decisionBlocks: summaries },
      ...(worst ? { decisionsAllTurns: worst } : {}),
    });
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(dir, 'report.md'), renderMarkdown(report) + `\nGrounding misses (fact not in the context sent): ${groundingMisses.join(', ') || 'none'}.\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
