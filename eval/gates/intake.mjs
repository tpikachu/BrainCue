#!/usr/bin/env node
/**
 * Stage 0 intake guards — the instant, deterministic checks every PR passes
 * before any expensive evaluation runs (docs/13-GITTENSOR.md §4).
 *
 *   BASE_REF=master PR_AUTHOR=someone PR_BODY="Closes #12" node eval/gates/intake.mjs
 *
 * Reads caps from eval/config/weights.json. Diffs BASE...HEAD (three-dot: only
 * the PR's own commits). Emits GitHub Actions annotations, writes
 * eval-intake.json for the scorecard step, and exits non-zero on gate failure.
 *
 * Maintainer-authored PRs (MAINTAINERS env, comma-separated) skip the size
 * caps — internal feature PRs are legitimately large — but never skip the
 * binary/generated-path bans or reporting.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'eval/config/weights.json'), 'utf8'));

const BASE = process.env.BASE_REF || 'master';
const AUTHOR = process.env.PR_AUTHOR || '';
const BODY = process.env.PR_BODY || '';
const MAINTAINERS = (process.env.MAINTAINERS || 'tpikachu')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const isMaintainer = MAINTAINERS.includes(AUTHOR.toLowerCase());

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// In CI the base branch usually isn't checked out locally — make it resolvable.
let baseRef = BASE;
try {
  git('rev-parse', '--verify', '--quiet', baseRef);
} catch {
  try {
    git('fetch', '--depth=1', 'origin', BASE);
    baseRef = 'FETCH_HEAD';
  } catch {
    console.error(`::error::intake: cannot resolve base ref '${BASE}'`);
    process.exit(2);
  }
}

// Paths that must never appear in a PR diff. Lockfile churn is allowed only
// alongside a package.json change (checked below), generated dirs never.
const BANNED = [/^node_modules\//, /^release\//, /^out\//, /^dist\//, /(^|\/)\.env/];

const numstat = git('diff', '--numstat', `${baseRef}...HEAD`)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [added, deleted, ...rest] = line.split('\t');
    return { added, deleted, file: rest.join('\t') };
  });

const failures = [];
const warnings = [];

// ── Size caps (external contributors only) ─────────────────────────────────
const changedFiles = numstat.length;
const changedLines = numstat.reduce(
  (n, f) => n + (f.added === '-' ? 0 : Number(f.added)) + (f.deleted === '-' ? 0 : Number(f.deleted)),
  0,
);
if (!isMaintainer) {
  if (changedFiles > cfg.caps.maxChangedFiles) {
    failures.push(
      `size: ${changedFiles} files changed (cap ${cfg.caps.maxChangedFiles}) — split this PR into one concern per PR`,
    );
  }
  if (changedLines > cfg.caps.maxChangedLines) {
    failures.push(
      `size: ${changedLines} lines changed (cap ${cfg.caps.maxChangedLines}) — split this PR into one concern per PR`,
    );
  }
}

// ── Binary + banned paths (everyone) ───────────────────────────────────────
for (const f of numstat) {
  if (BANNED.some((re) => re.test(f.file))) {
    failures.push(`generated/banned path in diff: ${f.file}`);
  }
  // git numstat marks binary files with "-" counts. Media/asset refreshes are
  // maintainer work (they're produced by the capture pipeline, not by hand).
  if (f.added === '-' && f.deleted === '-' && !isMaintainer) {
    failures.push(`binary file in external PR: ${f.file} — binary assets are maintainer-only`);
  }
}

// ── Lockfile without manifest ──────────────────────────────────────────────
const touched = new Set(numstat.map((f) => f.file));
if (touched.has('package-lock.json') && !touched.has('package.json')) {
  failures.push('package-lock.json changed without package.json — dependency churn is not accepted');
}

// ── Linked issue (ENFORCED — the bounty backlog is live) ───────────────────
// Every external PR must start from an issue: this gate is a required status
// check, so no linked issue = no merge. Re-runs on PR body edits, so adding
// "Closes #N" to the description unblocks without a new push.
if (!/(close[sd]?|fixe?[sd]?|resolve[sd]?)\s*:?\s+#\d+/i.test(BODY) && !isMaintainer) {
  failures.push(
    'no linked issue in the PR body — add "Closes #<issue>". Work must start from an issue (ideally a maintainer-labeled bounty:* one — see CONTRIBUTING.md)',
  );
}

// ── Report ─────────────────────────────────────────────────────────────────
for (const w of warnings) console.log(`::warning::intake: ${w}`);
for (const f of failures) console.log(`::error::intake: ${f}`);

const result = {
  gate: 'intake',
  pass: failures.length === 0,
  maintainerExempt: isMaintainer,
  changedFiles,
  changedLines,
  failures,
  warnings,
};
writeFileSync(resolve(ROOT, 'eval-intake.json'), JSON.stringify(result, null, 2));
console.log(
  `intake: ${changedFiles} files, ${changedLines} lines — ${result.pass ? 'PASS' : 'FAIL'}${isMaintainer ? ' (maintainer, size caps waived)' : ''}`,
);
process.exit(result.pass ? 0 : 1);
