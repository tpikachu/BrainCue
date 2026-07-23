#!/usr/bin/env node
/**
 * Secret scan over a PR's ADDED lines (docs/13-GITTENSOR.md §4, Stage 0).
 *
 *   BASE_REF=master node eval/gates/secret-scan.mjs
 *
 * Deliberately narrow patterns: this catches real credentials, not the
 * documentation placeholders this repo legitimately contains ("sk-…",
 * "ghp_your_token_here" are too short / non-random to match). A hit is a hard
 * gate failure — a leaked key in a public PR is compromised the moment it is
 * pushed, and the report says so.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const BASE = process.env.BASE_REF || 'master';

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

let baseRef = BASE;
try {
  git('rev-parse', '--verify', '--quiet', baseRef);
} catch {
  git('fetch', '--depth=1', 'origin', BASE);
  baseRef = 'FETCH_HEAD';
}

const PATTERNS = [
  { name: 'OpenAI API key', re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'GitHub token', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: 'Generic assigned secret', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{32,}['"]/i },
];

// unified=0: added lines only, with enough header context to attribute files.
const diff = git('diff', '--unified=0', `${baseRef}...HEAD`);

const findings = [];
let file = '';
let newLine = 0;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = line.slice(6);
    continue;
  }
  const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunk) {
    newLine = Number(hunk[1]);
    continue;
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    const text = line.slice(1);
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        findings.push({ file, line: newLine, pattern: p.name });
        console.log(
          `::error file=${file},line=${newLine}::secret-scan: possible ${p.name}. Treat this credential as COMPROMISED and rotate it now — removing the line does not un-leak it.`,
        );
      }
    }
    newLine++;
  } else if (!line.startsWith('-')) {
    // context lines don't occur at unified=0, but stay safe
    newLine++;
  }
}

const result = { gate: 'secret-scan', pass: findings.length === 0, findings };
writeFileSync(resolve(ROOT, 'eval-secrets.json'), JSON.stringify(result, null, 2));
console.log(`secret-scan: ${findings.length} finding(s) — ${result.pass ? 'PASS' : 'FAIL'}`);
process.exit(result.pass ? 0 : 1);
