#!/usr/bin/env node
/**
 * Tests + coverage-on-diff (Phase 1) — runs the unit suite, then measures how
 * much of THIS PR's changed code the suite actually executed.
 *
 *   BASE_REF=master node eval/gates/coverage-diff.mjs
 *
 * Two very different severities on purpose:
 *  - The test run itself is a HARD gate — a failing suite fails this script
 *    with vitest's own exit code.
 *  - Coverage of the changed lines is ADVISORY — a low number prints a
 *    warning and lands in the scorecard, but never fails the check. Whole-repo
 *    coverage thresholds punish whoever touches old code; diff coverage only
 *    ever talks about the lines this PR wrote.
 *
 * Scope: src/main + src/shared, .test files excluded. The renderer is
 * deliberately out of scope — it is exercised by the e2e suite against the
 * built app (e2e/README.md), which V8 unit coverage cannot see.
 *
 * Without BASE_REF (pushes to master), runs the plain suite and skips the
 * coverage pass entirely — nothing to diff against.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = resolve(ROOT, 'eval-coverage.json');
const COV_DIR = resolve(ROOT, '.coverage-tmp');
const THRESHOLD = 70; // advisory
const BASE = process.env.BASE_REF || '';

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const runVitest = (extra = []) => {
  // shell:true so the Windows npx shim resolves; cmd.exe does not glob, so the
  // coverage.include patterns pass through literally (vitest expands them).
  const res = spawnSync('npx', ['vitest', 'run', ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return res.status ?? 1;
};

// ── No base → plain hard-gated test run, no coverage ───────────────────────
if (!BASE) {
  process.exit(runVitest());
}

// ── Resolve base (same dance as intake.mjs — CI clones are shallow) ────────
let baseRef = BASE;
try {
  git('rev-parse', '--verify', '--quiet', baseRef);
} catch {
  try {
    git('fetch', '--unshallow', 'origin', BASE);
    baseRef = 'FETCH_HEAD';
  } catch {
    try {
      git('fetch', 'origin', BASE);
      baseRef = 'FETCH_HEAD';
    } catch {
      console.log(`::warning::coverage: cannot resolve base '${BASE}' — running tests only`);
      process.exit(runVitest());
    }
  }
}

// ── Changed lines in coverable files (new-file line numbers) ───────────────
const COVERABLE = /^src\/(main|shared)\/.*\.ts$/;
const isTest = (f) => /\.test\.tsx?$/.test(f);

const changed = new Map(); // file → Set<line>
let current = null;
for (const line of git('diff', '--unified=0', `${baseRef}...HEAD`, '--', 'src/main', 'src/shared').split('\n')) {
  const file = line.match(/^\+\+\+ b\/(.+)$/);
  if (file) {
    current = COVERABLE.test(file[1]) && !isTest(file[1]) ? file[1] : null;
    if (current && !changed.has(current)) changed.set(current, new Set());
    continue;
  }
  const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (hunk && current) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let l = start; l < start + count; l++) changed.get(current).add(l);
  }
}
for (const [f, lines] of changed) if (!lines.size) changed.delete(f); // pure deletions

if (!changed.size) {
  const code = runVitest();
  if (code !== 0) process.exit(code);
  writeFileSync(
    OUT,
    JSON.stringify(
      { gate: 'coverage-diff', advisory: true, skipped: true, reason: 'no coverable changes in src/main or src/shared' },
      null,
      2,
    ),
  );
  console.log('coverage: no coverable changes — tests passed, coverage skipped');
  process.exit(0);
}

// ── Instrumented run (hard gate on the tests themselves) ───────────────────
rmSync(COV_DIR, { recursive: true, force: true });
const code = runVitest([
  '--coverage.enabled',
  '--coverage.provider=v8',
  '--coverage.reporter=json',
  `--coverage.reportsDirectory=${COV_DIR}`,
  // `all` pulls in changed-but-never-imported files as 0% — exactly the case
  // diff coverage exists to catch.
  '--coverage.all',
  '--coverage.include=src/main/**/*.ts',
  '--coverage.include=src/shared/**/*.ts',
  '--coverage.exclude=**/*.test.ts',
]);
if (code !== 0) process.exit(code);

const covPath = resolve(COV_DIR, 'coverage-final.json');
if (!existsSync(covPath)) {
  console.log('::warning::coverage: vitest produced no coverage-final.json — skipping');
  process.exit(0);
}
const coverage = JSON.parse(readFileSync(covPath, 'utf8'));

// Istanbul keys are absolute paths — normalize to repo-relative posix.
const byFile = new Map();
for (const [abs, entry] of Object.entries(coverage)) {
  const rel = abs.startsWith(ROOT + sep) ? abs.slice(ROOT.length + 1).split(sep).join('/') : null;
  if (rel) byFile.set(rel, entry);
}

const files = [];
let totalCoverable = 0;
let totalCovered = 0;
for (const [file, lines] of changed) {
  const entry = byFile.get(file);
  if (!entry) {
    // Not instrumented (e.g. type-only module erased by the TS transform).
    files.push({ file, changed: lines.size, coverable: 0, covered: 0, note: 'not instrumented' });
    continue;
  }
  // A changed line is coverable if any statement spans it; covered if any such
  // statement executed. Lines outside every statement (types, braces) drop out.
  const lineHits = new Map(); // line → max hit count
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    const hits = entry.s[id] ?? 0;
    for (let l = loc.start.line; l <= loc.end.line; l++) {
      lineHits.set(l, Math.max(lineHits.get(l) ?? 0, hits));
    }
  }
  let coverable = 0;
  let covered = 0;
  const uncovered = [];
  for (const l of lines) {
    if (!lineHits.has(l)) continue;
    coverable++;
    if (lineHits.get(l) > 0) covered++;
    else uncovered.push(l);
  }
  totalCoverable += coverable;
  totalCovered += covered;
  files.push({
    file,
    changed: lines.size,
    coverable,
    covered,
    pct: coverable ? Math.round((covered / coverable) * 100) : null,
    uncoveredLines: uncovered.slice(0, 50),
  });
}

const totalPct = totalCoverable ? Math.round((totalCovered / totalCoverable) * 100) : null;
const result = {
  gate: 'coverage-diff',
  advisory: true,
  threshold: THRESHOLD,
  totalPct,
  totalCoverable,
  totalCovered,
  files,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));

if (totalPct !== null && totalPct < THRESHOLD) {
  console.log(
    `::warning::coverage: ${totalPct}% of this PR's changed executable lines are unit-covered (advisory floor ${THRESHOLD}%) — see eval-coverage.json`,
  );
}
console.log(
  totalPct === null
    ? 'coverage: changed lines contain no executable statements — nothing to measure'
    : `coverage: ${totalCovered}/${totalCoverable} changed executable lines covered (${totalPct}%)`,
);
process.exit(0);
