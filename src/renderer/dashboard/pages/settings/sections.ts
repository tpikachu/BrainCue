/**
 * The Settings information architecture — one catalog drives the left rail,
 * the search box, the route guard and the panel map (index.tsx). Adding a
 * section means adding an entry here and a panel there; `sections.test.ts`
 * fails if the two drift apart.
 *
 * Groups answer "what kind of thing am I changing?": APP is how BrainCue
 * behaves for you, AI MODELS is what it talks to, SYSTEM is the machine it
 * runs on. Keywords are what people type when they do not know our names for
 * things ("api key", "shortcut", "whisper", "delete everything").
 */

export type SettingsGroup = 'App' | 'AI models' | 'System';

export const SETTINGS_GROUPS: SettingsGroup[] = ['App', 'AI models', 'System'];

export type SettingsSectionId = 'preferences' | 'hotkeys' | 'speech' | 'models' | 'privacy' | 'system';

export interface SettingsSection {
  id: SettingsSectionId;
  group: SettingsGroup;
  title: string;
  /** One line under the title of its panel. */
  blurb: string;
  /** Search terms beyond the title (lower-case). */
  keywords: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'preferences',
    group: 'App',
    title: 'Preferences',
    blurb: 'Getting started, the coding solver’s language, and the companion',
    keywords: ['tour', 'help', 'getting started', 'coding language', 'companion', 'personality', 'do not disturb', 'budget', 'general'],
  },
  {
    id: 'hotkeys',
    group: 'App',
    title: 'Hotkeys',
    blurb: 'Global keyboard shortcuts — they work even when BrainCue is in the background',
    keywords: ['shortcut', 'shortcuts', 'keyboard', 'keys', 'accelerator', 'binding', 'summon'],
  },
  {
    id: 'speech',
    group: 'AI models',
    title: 'Speech-to-Text',
    blurb: 'Engines for live transcription',
    keywords: ['stt', 'transcription', 'transcribe', 'whisper', 'local', 'on-device', 'nvidia', 'nemotron', 'download', 'audio', 'engine', 'offline'],
  },
  {
    id: 'models',
    group: 'AI models',
    title: 'Language Models',
    blurb: 'Models for answers, coding solutions and summaries',
    keywords: ['api key', 'key', 'openai', 'anthropic', 'claude', 'gemini', 'google', 'groq', 'openrouter', 'provider', 'providers', 'gpt', 'llm', 'preset', 'model'],
  },
  {
    id: 'privacy',
    group: 'System',
    title: 'Privacy & Data',
    blurb: 'Screen-share invisibility, the taskbar, what is remembered, and what can be erased',
    keywords: ['privacy mode', 'screen share', 'capture', 'hidden', 'taskbar', 'memory', 'remember', 'data', 'wipe', 'delete', 'reset', 'danger', 'erase'],
  },
  {
    id: 'system',
    group: 'System',
    title: 'System',
    blurb: 'Software updates and troubleshooting tools',
    keywords: ['update', 'updates', 'version', 'upgrade', 'advanced', 'db explorer', 'database', 'debug', 'troubleshooting', 'support'],
  },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'preferences';

export function isSettingsSection(id: string | undefined): id is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === id);
}

export function settingsSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.id === id)!;
}

/** Sections whose title or keywords contain every word of `query`. An empty
 *  query returns everything, in catalog order. */
export function filterSections(query: string): SettingsSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter((s) => {
    const hay = [s.title, s.group, s.blurb, ...s.keywords].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** `/settings/<id>` — the one place the URL shape is written. */
export function settingsPath(id: SettingsSectionId): string {
  return `/settings/${id}`;
}
