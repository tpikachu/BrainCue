import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, cmpDesc, parseVersion, RELEASES } from './changelog';

describe('changelog versions', () => {
  it('parses release and prerelease file names; anything else is not a version', () => {
    expect(parseVersion('/changelog/2.2.2.md')).toBe('2.2.2');
    expect(parseVersion('/changelog/2.3.0-preview.1.md')).toBe('2.3.0-preview.1');
    expect(parseVersion('/changelog/README.md')).toBe('');
    expect(parseVersion('/changelog/2.3.md')).toBe('');
  });

  it('orders newest first, with a prerelease below its release and above what came before', () => {
    const sorted = ['2.2.2', '2.3.0', '2.3.0-preview.10', '2.3.0-preview.2', '2.3.0-preview.1', '2.2.10', '2.3.0-rc.1'].sort(cmpDesc);
    expect(sorted).toEqual(['2.3.0', '2.3.0-rc.1', '2.3.0-preview.10', '2.3.0-preview.2', '2.3.0-preview.1', '2.2.10', '2.2.2']);
  });

  it('the app version (the newest changelog entry) is package.json’s version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(RELEASES.map((r) => r.version)).toContain('2.2.2');
  });
});
