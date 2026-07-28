import { useState } from 'react';
import { useProfileStore } from '../store/useProfileStore';
import { Dropdown } from '../components/ui';
import { UserIcon } from '../components/icons';
import { NewProfileModal } from './NewProfileModal';

/** Sentinel option — "New profile…" lives in the same menu as the switch,
 *  because both answer "whose dashboard is this?" and splitting them into a
 *  dropdown plus a separate button puts the rarer action in the bigger target. */
const NEW = '__new__';

/**
 * Whose dashboard this is, chosen once (docs/19-ACTIVE-PROFILE.md).
 *
 * Sits in the sidebar above the nav, so the scope of everything below it is
 * visible at all times rather than being re-asked on each page. The Library's
 * four tabs, the start modal, and the interview pages all read this now.
 */
export function ProfileSwitcher() {
  const { profiles, activeId, setActive } = useProfileStore();
  const [creating, setCreating] = useState(false);

  // Nothing to switch between yet: the first-run gate in App is what asks.
  if (profiles.length === 0) return null;

  const options = [
    ...profiles.map((p) => ({ value: p.id, label: p.name })),
    { value: NEW, label: '+ New profile…' },
  ];

  return (
    <div className="mb-4" data-tour="profile-switcher">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        <UserIcon className="h-3 w-3" />
        Profile
      </div>
      <Dropdown
        value={activeId ?? ''}
        options={options}
        onChange={(v) => {
          if (v === NEW) setCreating(true);
          else void setActive(v);
        }}
        buttonClassName="flex w-full items-center justify-between gap-2 rounded-lg border border-white/5 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 outline-none transition-colors hover:bg-neutral-900 focus:border-indigo-500"
      />
      <NewProfileModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
