import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api';
import { useLiveSession } from '../store/useLiveSession';
import { UserIcon, LibraryIcon, ReportIcon } from '../components/icons';
import { APP_VERSION } from './changelog';

interface Stats {
  profiles: number;
  interviews: number; // physical name kept for IPC compat — these are Spaces
  sessions: number;
  liveSessions: number;
}

/** What a live session is called, per mode — the status card must speak every
 *  mode's language, not assume an interview. */
const LIVE_LABELS: Record<string, string> = {
  interview: 'Interview live',
  practice: 'Practice live',
  meeting: 'Meeting live',
  companion: 'Companion live',
};

/** Live status block at the bottom of the dashboard sidebar: profile/session
 *  counts, an "active session" indicator, and the changelog link. Refreshes on
 *  session-state changes, data wipes, and when the window regains focus. */
export function SidebarStatus() {
  const [stats, setStats] = useState<Stats | null>(null);
  const session = useLiveSession((s) => s.session);

  const refresh = useCallback(() => {
    void api.data.stats().then(setStats);
  }, []);

  useEffect(() => {
    refresh();
    const offState = api.events.onSessionState(refresh);
    const offData = api.events.onDataChanged(refresh);
    window.addEventListener('focus', refresh);
    return () => {
      offState();
      offData();
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const live = (stats?.liveSessions ?? 0) > 0;

  return (
    <div className="mt-auto space-y-2">
      <div className="rounded-xl border border-white/5 bg-neutral-950/50 p-3">
        <div className="mb-2.5 flex items-center gap-2">
          <span className={`relative flex h-2 w-2 ${live ? '' : 'opacity-60'}`}>
            {live && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                live ? 'bg-green-400' : 'bg-neutral-600'
              }`}
            />
          </span>
          <span className="text-xs font-medium text-neutral-300">
            {live ? (LIVE_LABELS[session?.mode ?? ''] ?? 'Session live') : 'Idle'}
          </span>
        </div>

        <div className="space-y-1">
          <Stat icon={<UserIcon className="h-3.5 w-3.5" />} label="Profiles" value={stats?.profiles} />
          <Stat icon={<LibraryIcon className="h-3.5 w-3.5" />} label="Spaces" value={stats?.interviews} />
          <Stat icon={<ReportIcon className="h-3.5 w-3.5" />} label="Sessions" value={stats?.sessions} />
        </div>
      </div>

      <NavLink
        to="/whats-new"
        className={({ isActive }) =>
          `block rounded-md px-2 py-1 text-center text-[11px] transition-colors ${
            isActive ? 'text-indigo-300' : 'text-neutral-600 hover:text-neutral-400'
          }`
        }
      >
        v{APP_VERSION} · What's new
      </NavLink>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value?: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1.5">
      <span className="flex items-center gap-1.5 text-xs text-neutral-400">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-neutral-100">{value ?? '—'}</span>
    </div>
  );
}
