import type React from 'react';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { SearchInput } from '../../../components/ui';
import {
  BoltIcon,
  DatabaseIcon,
  EyeOffIcon,
  MicIcon,
  SettingsIcon,
  SparklesIcon,
} from '../../../components/icons';
import {
  SETTINGS_GROUPS,
  filterSections,
  settingsPath,
  type SettingsSectionId,
} from './sections';

const ICONS: Record<SettingsSectionId, (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  preferences: SettingsIcon,
  hotkeys: BoltIcon,
  speech: MicIcon,
  models: SparklesIcon,
  privacy: EyeOffIcon,
  system: DatabaseIcon,
};

/**
 * Settings shell: a left rail of grouped sections with a search box, and the
 * active section's panel on the right. The rail is the page's own navigation
 * (the sidebar still says "Settings" for all of it), so the panel keeps the
 * fixed-header / scrolling-body shape the other pages have.
 *
 * Search filters the rail by title and keywords; it does not search inside a
 * panel. Six sections is few enough that finding the right heading IS the job.
 */
export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const visible = filterSections(query);

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-neutral-950/40"
      >
        <div className="px-3 pb-2 pt-4">
          <h2 className="mb-3 px-1 text-lg font-semibold tracking-tight">Settings</h2>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="py-1.5 text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {SETTINGS_GROUPS.map((group) => {
            const items = visible.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mt-3">
                <div className="mb-1 px-3 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  {group}
                </div>
                <ul className="space-y-0.5">
                  {items.map((s) => {
                    const Icon = ICONS[s.id];
                    return (
                      <li key={s.id}>
                        <NavLink
                          to={settingsPath(s.id)}
                          data-settings-section={s.id}
                          className={({ isActive }) =>
                            `relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                              isActive
                                ? 'bg-indigo-500/10 text-white'
                                : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                            }`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span
                                className={`absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r bg-indigo-400 ${
                                  isActive ? 'opacity-100' : 'opacity-0'
                                }`}
                              />
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="truncate">{s.title}</span>
                            </>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {visible.length === 0 && (
            <p className="mt-6 px-3 text-xs text-neutral-500">
              Nothing matches “{query}”. Try “key”, “shortcut”, or “privacy”.
            </p>
          )}
        </div>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</section>
    </div>
  );
}

/** A panel's fixed header: title, one-line blurb, and an optional right-hand
 *  slot (a status badge, an action). Followed by {@link PanelBody}. */
export function PanelHeader({
  title,
  blurb,
  aside,
}: {
  title: string;
  blurb: string;
  aside?: React.ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-white/5 bg-neutral-950/70 px-8 py-5 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-neutral-400">{blurb}</p>
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2 pt-1">{aside}</div>}
      </div>
    </header>
  );
}

/** The scrolling body under a {@link PanelHeader}. Cards inside stack with
 *  `space-y-5`, so panels do not carry their own margins. */
export function PanelBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
      <div className="page-enter mx-auto w-full max-w-2xl space-y-5">{children}</div>
    </div>
  );
}
