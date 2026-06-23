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

/** "/changelog/0.2.0.md" -> "0.2.0"; non-version files (README) -> "". */
function parseVersion(path: string): string {
  const m = path.match(/\/(\d+\.\d+\.\d+)\.md$/);
  return m ? m[1] : '';
}

/** Descending semver compare (newest first). */
function cmpDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const RELEASES: Release[] = Object.entries(files)
  .map(([path, body]) => ({ version: parseVersion(path), body: body.trim() }))
  .filter((r) => r.version) // drop README.md and anything not named <semver>.md
  .sort((a, b) => cmpDesc(a.version, b.version));

/** Current app version = the newest changelog entry. */
export const APP_VERSION = RELEASES[0]?.version ?? '';
