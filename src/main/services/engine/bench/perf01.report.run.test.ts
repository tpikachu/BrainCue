import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveReport, readEvidence } from './perf01.evidence';

/**
 * PERF-01 LIVE REPORT. It turns a live driver's results folder
 * (e2e/live-perf01.spec.ts → bench-results/perf01/live-<stamp>/) into
 * report.md and report.json. Skipped unless PERF01_RESULTS names that folder:
 *
 *   $env:PERF01_RESULTS = 'bench-results\perf01\live-<stamp>'; npm run perf01:report
 *
 * The folder is first CHECKED against its manifest (perf01.evidence.ts):
 * - every planned block and fixture once;
 * - fresh processes for cold starts;
 * - the reference route, grounding and decision evidence;
 * - an uncapped budget.
 *
 * Only a valid folder gets verdicts. Any issue makes every verdict
 * "invalid evidence"; the latencies stay in the report as diagnostics.
 * Every planned fixture is in the denominator, and one with no record is
 * unanswered. The warm-ups are not samples.
 *
 * The report is always written. The runner then FAILS on invalid evidence,
 * so the command itself says whether the folder can be used.
 */
const DIR = process.env.PERF01_RESULTS;

describe.skipIf(!DIR)('PERF-01 live report', () => {
  it('writes report.md and report.json, and fails unless the evidence is valid', () => {
    const dir = path.resolve(DIR!);
    const { report, markdown, validated } = liveReport(readEvidence(dir));
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(dir, 'report.md'), markdown);
    expect(validated.issues, `evidence check (${dir}${path.sep}report.md)`).toEqual([]);
  });
});
