#!/usr/bin/env node
/**
 * Push the label taxonomy in eval/config/labels.json to the GitHub repo.
 * Create-or-update per label; never deletes (removing a label from the JSON
 * means retiring it manually — deletion cascades off issues, so it stays a
 * deliberate human act).
 *
 *   GITHUB_TOKEN=ghp_xxx node scripts/sync-labels.mjs [owner/repo]
 *
 * Token needs `issues: write` (fine-grained) or `repo` (classic).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = process.argv[2] || process.env.GITHUB_REPOSITORY || 'tpikachu/BrainCue';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required (issues: write).');
  process.exit(2);
}

const { labels } = JSON.parse(readFileSync(resolve(ROOT, 'eval/config/labels.json'), 'utf8'));

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
};

let created = 0;
let updated = 0;
let failed = 0;
for (const label of labels) {
  const payload = { name: label.name, color: label.color, description: label.description };
  const patch = await api('PATCH', `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`, payload);
  if (patch.ok) {
    updated++;
    continue;
  }
  if (patch.status === 404) {
    const post = await api('POST', `/repos/${REPO}/labels`, payload);
    if (post.ok) {
      created++;
      continue;
    }
    console.error(`  ✗ ${label.name}: create failed ${post.status} ${await post.text()}`);
    failed++;
  } else {
    console.error(`  ✗ ${label.name}: update failed ${patch.status} ${await patch.text()}`);
    failed++;
  }
}

console.log(`labels: ${created} created, ${updated} updated, ${failed} failed (${REPO})`);
process.exit(failed ? 1 : 0);
