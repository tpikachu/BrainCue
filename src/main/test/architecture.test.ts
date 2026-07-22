import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Architecture contract tests (v2 baseline guardrail).
 *
 * The security model requires that the renderer never touches the OpenAI SDK,
 * the database, or the API key — all provider/DB/secret access lives in main,
 * behind the typed preload facade. These tests make that contract executable:
 * they fail the suite if a source file (or the built renderer bundle) grows a
 * forbidden dependency, instead of leaving it to review to catch.
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

/** Packages that must never be imported outside the main process. */
const MAIN_ONLY_PACKAGES = ['openai', 'better-sqlite3', 'drizzle-orm', 'ws', 'electron-updater'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Extract import/require specifiers with whether each is type-only (erased). */
function specifiers(source: string): { spec: string; typeOnly: boolean }[] {
  const found: { spec: string; typeOnly: boolean }[] = [];
  // `import ... from 'x'` / `export ... from 'x'` (multiline-safe)
  for (const m of source.matchAll(/(import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    found.push({ spec: m[3], typeOnly: !!m[2] });
  }
  // side-effect `import 'x'`, dynamic `import('x')`, `require('x')`
  for (const m of source.matchAll(/import\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g)) {
    found.push({ spec: m[1], typeOnly: false });
  }
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ spec: m[1], typeOnly: false });
  }
  return found;
}

function isMainOnlyPackage(spec: string): boolean {
  return MAIN_ONLY_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
}

/** Does a relative specifier resolve inside the given directory? */
function resolvesInto(file: string, spec: string, dir: string): boolean {
  if (!spec.startsWith('.')) return false;
  const resolved = path.resolve(path.dirname(file), spec);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

function violations(
  files: string[],
  rule: (spec: string, file: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { spec, typeOnly } of specifiers(source)) {
      if (typeOnly) continue; // erased at compile time — cannot enter a bundle
      const why = rule(spec, file);
      if (why) out.push(`${path.relative(ROOT, file)} imports '${spec}' (${why})`);
    }
  }
  return out;
}

const MAIN_DIR = path.join(SRC, 'main');
const SHARED_DIR = path.join(SRC, 'shared');

describe('process-boundary imports', () => {
  it('renderer imports no main-process modules, electron, or main-only packages', () => {
    const files = walk(path.join(SRC, 'renderer'));
    expect(files.length).toBeGreaterThan(20); // sanity: the walker actually found the app
    const bad = violations(files, (spec, file) => {
      if (spec === 'electron' || spec.startsWith('electron/')) return 'electron is main/preload-only';
      if (spec.startsWith('@main')) return 'renderer must not reach into src/main';
      if (isMainOnlyPackage(spec)) return 'main-only package';
      if (resolvesInto(file, spec, MAIN_DIR)) return 'relative import into src/main';
      return null;
    });
    expect(bad).toEqual([]);
  });

  it('preload imports no OpenAI/DB modules and does not reach into src/main', () => {
    const files = walk(path.join(SRC, 'preload'));
    const bad = violations(files, (spec, file) => {
      if (spec.startsWith('@main')) return 'preload must not reach into src/main';
      if (isMainOnlyPackage(spec)) return 'main-only package';
      if (resolvesInto(file, spec, MAIN_DIR)) return 'relative import into src/main';
      return null;
    });
    expect(bad).toEqual([]);
  });

  it('shared modules stay dependency-free (no electron, no main-only packages, no process code)', () => {
    const files = walk(SHARED_DIR);
    const bad = violations(files, (spec, file) => {
      if (spec === 'electron' || spec.startsWith('electron/')) return 'shared must stay process-agnostic';
      if (spec.startsWith('@main') || spec.startsWith('@renderer')) return 'shared must not depend on a process';
      if (isMainOnlyPackage(spec)) return 'main-only package';
      if (spec.startsWith('.') && !resolvesInto(file, spec, SHARED_DIR)) return 'relative import escaping src/shared';
      return null;
    });
    expect(bad).toEqual([]);
  });
});

describe('built renderer bundle', () => {
  const rendererOut = path.join(ROOT, 'out', 'renderer');
  // Only meaningful after `npm run build`; skip (not fail) when out/ is absent
  // so the unit suite stays runnable on a fresh clone.
  const itIfBuilt = existsSync(rendererOut) ? it : it.skip;

  itIfBuilt('contains no OpenAI endpoint, key-store, or DB markers', () => {
    const assets = walk2(rendererOut).filter((f) => f.endsWith('.js'));
    expect(assets.length).toBeGreaterThan(0);
    // Markers chosen to be present in main-process modules but absent from
    // legitimate renderer copy (the renderer may say "OpenAI" in UI labels —
    // that is fine; reaching the API host or key store is not).
    const markers = ['api.openai.com', 'apiKeyStore', 'better_sqlite3', 'safeStorage', 'getDecrypted'];
    for (const asset of assets) {
      const text = readFileSync(asset, 'utf8');
      for (const marker of markers) {
        expect(text.includes(marker), `${path.relative(ROOT, asset)} contains '${marker}'`).toBe(false);
      }
    }
  });
});

/** walk() variant without the .ts filter, for build output. */
function walk2(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk2(p));
    else out.push(p);
  }
  return out;
}
