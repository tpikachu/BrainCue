import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A rot guard, not a unit test (docs/19-ACTIVE-PROFILE.md).
 *
 * The dashboard is scoped to ONE profile. Two IPC reads take `profileId` as an
 * OPTIONAL argument, because main also serves the overlay and the dev DB
 * explorer, which legitimately want everything. That optionality is the trap:
 * omitting the argument in a dashboard page is not a type error, so it compiles,
 * renders, and silently shows one person's sessions under another person's name.
 *
 * It has happened twice — Sessions and Insights the first time, Home the second,
 * where the greeting says "Hi Sky" directly above someone else's calls. Neither
 * was catchable by a typecheck and neither had a test, so this reads the source
 * and fails on a bare call. Renderer components have no test harness here (no
 * jsdom), which is why this is a source scan rather than a render assertion.
 *
 * If a NEW surface genuinely needs every profile, widen `ALLOWED` with the
 * reason — the point is that the decision is made deliberately, not by omission.
 */

/** Reads whose `profileId` is optional in the preload API. Whitespace is
 *  allowed between every part: the real call that leaked was formatted across
 *  three lines by the formatter, and a regex that assumed one line matched
 *  nothing at all — a guard that passes because it never looks. */
const UNSCOPED_CALL = /\bapi\s*\.\s*session\s*\.\s*(list|practiceStats)\s*\(\s*\)/g;

/** Files allowed to read across every profile, and why. */
const ALLOWED: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return walk(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('every dashboard read is scoped to the active profile', () => {
  it('never calls a profile-scoped session read without a profile', () => {
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), 'src', 'renderer'))) {
      const rel = file.split(/[\\/]src[\\/]/)[1].replace(/\\/g, '/');
      if (rel in ALLOWED) continue;
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(UNSCOPED_CALL)) offenders.push(`src/${rel}: ${m[0]}`);
    }
    expect(
      offenders,
      'pass the active profile id — an empty call returns every profile’s rows',
    ).toEqual([]);
  });

  it('would catch the regression it exists for', () => {
    // Proves the pattern matches the real shape, so an empty ALLOWED list and a
    // passing suite cannot mean the regex simply never matches anything.
    const good = 'const all = await api.session.list(profileId);';
    expect(good.match(UNSCOPED_CALL)).toBeNull();
    expect('api.session.practiceStats()'.match(UNSCOPED_CALL)).not.toBeNull();
    // Both shapes the leak has actually taken: one line, and the multi-line
    // form the formatter produces for a chained call.
    expect('const all = await api.session.list();'.match(UNSCOPED_CALL)).not.toBeNull();
    expect('void api.session\n      .list()\n      .then(x)'.match(UNSCOPED_CALL)).not.toBeNull();
  });
});
