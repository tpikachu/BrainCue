// Build-time loader for the repo's `changelog/*.md` files. The renderer root is
// the project root (see electron.vite.config.ts), so `/changelog/*.md` resolves
// to the top-level `changelog/` directory — the single source of truth for
// release notes. These are inlined as raw strings at build time and surfaced in
// the in-app "What's New" view, so the docs and the app never drift apart.
const files = import.meta.glob('/changelog/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface Release {
  version: string; // e.g. "0.2.0"
  body: string; // the file's markdown (already starts with an H1 heading)
}

/** "/changelog/0.2.0.md" -> "0.2.0", "/changelog/2.3.0-preview.1.md" ->
 *  "2.3.0-preview.1"; non-version files (README) -> "". */
export function parseVersion(path: string): string {
  const m = path.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)\.md$/);
  return m ? m[1] : '';
}

/** Descending semver compare (newest first). A prerelease sorts below its
 *  release (2.3.0-preview.1 < 2.3.0) and above everything before it; its
 *  identifiers compare numerically when numeric (preview.2 < preview.10). */
export function cmpDesc(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (coreB[i] ?? 0) - (coreA[i] ?? 0);
    if (d) return d;
  }
  if (!preA.length || !preB.length) return preA.length - preB.length; // the release first
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return 1; // fewer identifiers: lower precedence
    if (y === undefined) return -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    const d = nx && ny ? Number(y) - Number(x) : nx ? 1 : ny ? -1 : y < x ? -1 : y > x ? 1 : 0;
    if (d) return d;
  }
  return 0;
}

function splitVersion(v: string): [number[], string[]] {
  const [core, ...pre] = v.split('-');
  const p = pre.join('-');
  return [core.split('.').map(Number), p ? p.split('.') : []];
}

export const RELEASES: Release[] = Object.entries(files)
  .map(([path, body]) => ({ version: parseVersion(path), body: body.trim() }))
  .filter((r) => r.version) // drop README.md and anything not named <semver>.md
  .sort((a, b) => cmpDesc(a.version, b.version));

/** Current app version = the newest changelog entry. */
export const APP_VERSION = RELEASES[0]?.version ?? '';
