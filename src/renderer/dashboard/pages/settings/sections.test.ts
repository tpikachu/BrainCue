import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  filterSections,
  isSettingsSection,
  settingsPath,
} from './sections';

// The panels reach the preload bridge on import (through the store); there is
// no window here. Nothing is rendered — the map is inspected for coverage.
vi.mock('../../../lib/api', () => ({ api: {} }));

import { PANELS } from './index';

describe('the Settings section catalog', () => {
  it('has a panel for every section, and no orphan panels', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id).sort();
    expect(Object.keys(PANELS).sort()).toEqual(ids);
    expect(new Set(ids).size, 'duplicate section id').toBe(ids.length);
  });

  it('files every section under one of the three groups, in rail order', () => {
    for (const s of SETTINGS_SECTIONS) expect(SETTINGS_GROUPS).toContain(s.group);
    // Every group has at least one entry, or the rail shows an empty heading.
    for (const g of SETTINGS_GROUPS) expect(SETTINGS_SECTIONS.some((s) => s.group === g)).toBe(true);
  });

  it('routes as /settings/<id> and knows its default', () => {
    expect(isSettingsSection(DEFAULT_SETTINGS_SECTION)).toBe(true);
    expect(isSettingsSection('nope')).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
    expect(settingsPath('models')).toBe('/settings/models');
  });

  it('carries the copy each panel header shows', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.blurb.length, s.id).toBeGreaterThan(10);
      expect(s.keywords.length, s.id).toBeGreaterThan(2);
    }
  });
});

describe('searching the rail', () => {
  it('returns everything for an empty query, in catalog order', () => {
    expect(filterSections('')).toEqual(SETTINGS_SECTIONS);
    expect(filterSections('   ')).toEqual(SETTINGS_SECTIONS);
  });

  it('matches titles and keywords case-insensitively', () => {
    expect(filterSections('HOTKEYS').map((s) => s.id)).toEqual(['hotkeys']);
    expect(filterSections('shortcut').map((s) => s.id)).toEqual(['hotkeys']);
    expect(filterSections('api key').map((s) => s.id)).toContain('models');
    expect(filterSections('anthropic').map((s) => s.id)).toEqual(['models']);
    expect(filterSections('whisper').map((s) => s.id)).toEqual(['speech']);
    expect(filterSections('screen share').map((s) => s.id)).toEqual(['privacy']);
  });

  it('requires every word to match, and returns nothing for nonsense', () => {
    expect(filterSections('local download').map((s) => s.id)).toEqual(['speech']);
    expect(filterSections('xyzzy')).toEqual([]);
  });
});
