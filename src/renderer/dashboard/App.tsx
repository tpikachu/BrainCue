import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTourStore } from '../store/useTourStore';
import { Tour, TOUR_STEPS } from './Tour';
import HomePage from './pages/HomePage';
import LibraryPage from './pages/LibraryPage';
import MemoryPage from './pages/MemoryPage';
import ProfilesPage from './pages/ProfilesPage';
import ProfileEditorPage from './pages/ProfileEditorPage';
import InterviewPage from './pages/InterviewPage';
import MockPage from './pages/MockPage';
import SparringPage from './pages/SparringPage';
import TailorPage from './pages/TailorPage';
import SessionsPage from './pages/SessionsPage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import WhatsNewPage from './pages/WhatsNewPage';
import HelpPage from './pages/HelpPage';
import DevDbExplorerPage from './pages/DevDbExplorerPage';
import { Titlebar } from './Titlebar';
import { SidebarStatus } from './SidebarStatus';
import { UpdateBanner } from './UpdateBanner';
import { SavePromptModal } from './SavePromptModal';
import { ProfileSwitcher } from './ProfileSwitcher';
import { NewProfileModal } from './NewProfileModal';
import { useProfileStore } from '../store/useProfileStore';
import {
  ChevronLeftIcon,
  ClockIcon,
  DatabaseIcon,
  HomeIcon,
  LibraryIcon,
  ReportIcon,
  SettingsIcon,
  SparklesIcon,
  UserIcon,
} from '../components/icons';
import { Logo } from '../components/Logo';
import { FLAGS } from '@shared/flags';

// Dev-only DB explorer — shown/routed only in unpackaged builds.
const DEV = import.meta.env.DEV;

/**
 * The sidebar in two groups, because its entries answer two different questions
 * (docs/19-ACTIVE-PROFILE.md).
 *
 * Everything in the first group shows ONE person's things and changes entirely
 * when the switcher above it changes. Everything in the second is about the app
 * or about the set of people, and does not move when you switch. Running them
 * together as one list made the switcher look like it scoped Settings too — and
 * hid that Home, Library, Sessions, and Insights are all views of whoever is
 * selected.
 *
 * Activities live as launcher cards on Home, so adding one never adds a nav
 * item. Old routes stay registered below — Home cards, the tray, and hotkeys
 * deep-link into them; retired paths redirect.
 */
const PROFILE_NAV = [
  { to: '/home', label: 'Home', Icon: HomeIcon, tour: 'nav-home' },
  { to: '/library', label: 'Library', Icon: LibraryIcon, tour: 'nav-library' },
  // Memory is its own section, not a Library tab: the Library is the knowledge
  // base you assemble, Memory is what BrainCue proposes to keep and is waiting
  // on your decision. Flag-gated because the whole surface can be unshipped.
  ...(FLAGS.memory
    ? [{ to: '/memory', label: 'Memory', Icon: SparklesIcon, tour: 'nav-memory' }]
    : []),
  { to: '/sessions', label: 'Sessions', Icon: ClockIcon, tour: 'nav-sessions' },
  { to: '/reports', label: 'Insights', Icon: ReportIcon, tour: 'nav-reports' },
];

/** `showDb`: the DB Explorer reads every table raw, so it is a support tool
 *  rather than a feature — always present in a dev build, and in a packaged one
 *  only after the user turns it on in Settings. */
const appNav = (showDb: boolean) => [
  { to: '/profiles', label: 'Profiles', Icon: UserIcon, tour: 'nav-profiles' },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, tour: 'nav-settings' },
  ...(showDb ? [{ to: '/dev', label: 'DB Explorer', Icon: DatabaseIcon, tour: 'nav-dev' }] : []),
];

// Pages launched from Home's activity/tool cards. They have no sidebar entry
// of their own, so while one is open the Home nav item stays highlighted and a
// breadcrumb bar provides the way back — a card-launched page reads as "inside
// Home", not orphaned.
//
// Named for the activity, not the engine mode behind it: "Interview Copilot"
// was a product name from when the app WAS one.
const HOME_LAUNCHED: Record<string, string> = {
  '/interview': 'Interview',
  '/mock': 'Practice · Mock interview',
  '/sparring': 'Practice · Sparring drill',
  ...(FLAGS.jobSearch ? { '/tailor': 'Tailor Resume' } : {}),
};

export default function App() {
  const { settings, load: loadSettings } = useSettingsStore();
  const { profiles, activeId, loaded: profilesLoaded, load: loadProfiles } = useProfileStore();
  const activeProfile = profiles.find((p) => p.id === activeId);
  const { running, start, stop } = useTourStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [version, setVersion] = useState('');
  const modeLabel = HOME_LAUNCHED[location.pathname];

  useEffect(() => {
    void api.app.getInfo().then((i) => setVersion(i.version));
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // The shell owns the profile list, because the sidebar switcher scopes every
  // page under it — pages read the active profile, they no longer fetch to ask.
  //
  // It also re-reads it whenever MAIN says the data changed, because main can
  // add or remove profiles without going through this store: loading sample
  // data, and wiping everything from Settings → Danger zone. Without this the
  // shell keeps a list the database no longer agrees with — a wipe leaves
  // deleted profiles in the switcher, and seeding the first profile leaves the
  // non-dismissable first-run modal covering an app that now has one.
  useEffect(() => {
    void loadProfiles();
    return api.events.onDataChanged(() => void loadProfiles());
  }, [loadProfiles]);

  // Let the tray "Settings" item route the dashboard here.
  useEffect(() => {
    return api.events.onNavigate((p) => navigate((p as { path: string }).path));
  }, [navigate]);

  // Auto-launch the tour once for a brand-new user (tourDone is persisted, so
  // finishing/skipping prevents it from showing again).
  useEffect(() => {
    if (settings && !settings.tourDone) start();
  }, [settings, start]);

  const finishTour = async () => {
    stop();
    await api.settings.set({ tourDone: true });
    await loadSettings();
  };

  return (
    <div className="flex h-screen flex-col bg-gradient-to-b from-neutral-950 to-neutral-900 text-neutral-100">
      <Titlebar />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-neutral-950/60 p-4">
        <Link
          to="/whats-new"
          title="What’s new"
          className="brand group mb-8 flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-white/5"
        >
          <span className="logo-glow relative inline-flex transition-transform duration-300 group-hover:scale-105">
            <Logo className="h-9 w-9" />
          </span>
          <div className="leading-tight">
            <h1 className="brand-gradient text-sm font-semibold tracking-tight">BrainCue</h1>
            <div className="mt-0.5 flex items-center gap-1.5">
              {version && (
                <span className="version-pill rounded-full border border-white/10 bg-white/5 px-1.5 py-px text-[10px] font-medium tabular-nums text-neutral-400">
                  v{version}
                </span>
              )}
            </div>
          </div>
        </Link>
        <ProfileSwitcher />

        <nav aria-label="For this profile" className="space-y-1">
          <NavGroupLabel>{activeProfile?.name ?? 'This profile'}</NavGroupLabel>
          {PROFILE_NAV.map((n) => (
            <NavItem key={n.to} item={n} homeActive={!!modeLabel} />
          ))}
        </nav>

        <nav aria-label="App" className="mt-6 space-y-1 border-t border-white/5 pt-4">
          <NavGroupLabel>App</NavGroupLabel>
          {appNav(DEV || !!settings?.devDbExplorer).map((n) => (
            <NavItem key={n.to} item={n} homeActive={false} />
          ))}
        </nav>

        <SidebarStatus />
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {modeLabel && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-white/5 bg-neutral-950/40 px-4 py-2 text-sm">
            <Link
              to="/home"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-200"
            >
              <ChevronLeftIcon className="h-4 w-4" />
              Home
            </Link>
            <span className="text-neutral-600">/</span>
            <span className="font-medium text-neutral-200">{modeLabel}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route
              path="/memory"
              element={FLAGS.memory ? <MemoryPage /> : <Navigate to="/library" replace />}
            />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/profiles/:id" element={<ProfileEditorPage />} />
            <Route path="/interview" element={<InterviewPage />} />
            <Route path="/mock" element={<MockPage />} />
            <Route path="/sparring" element={<SparringPage />} />
            {/* Job-search tooling is quarantined behind a flag (shared/flags.ts):
                the page and its data are intact, but a companion for daily
                conversations should not lead with résumé tailoring. A stale
                deep-link lands on Home rather than a dead route. */}
            <Route
              path="/tailor"
              element={FLAGS.jobSearch ? <TailorPage /> : <Navigate to="/home" replace />}
            />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/whats-new" element={<WhatsNewPage />} />
            <Route path="/help" element={<HelpPage />} />
            {/* Same condition as the nav entry, or the sidebar would offer a
                link that redirects — and a stale deep-link would 404. */}
            {(DEV || settings?.devDbExplorer) && (
              <Route path="/dev" element={<DevDbExplorerPage />} />
            )}
          </Routes>
        </div>
      </main>
      </div>

      {/* Global: sessions can be started from several pages and stopped from the
          Cue Card — the save-or-discard prompt must appear wherever the user is. */}
      <SavePromptModal />
      {/* First run: BrainCue works for one person, and nothing below can do
          anything without knowing who. Not dismissable — there is no dashboard
          behind it to go back to, and an app of empty lists reads as broken
          rather than as "start here". */}
      <NewProfileModal
        open={profilesLoaded && profiles.length === 0}
        dismissable={false}
        onClose={() => {}}
      />

      {running && <Tour steps={TOUR_STEPS} onClose={finishTour} />}
    </div>
  );
}

/** The scope of the group beneath it. The first group's label is the active
 *  profile's own name — the plainest possible statement of what changes when
 *  the switcher changes. */
function NavGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 truncate px-3 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  );
}

interface NavEntry {
  to: string;
  label: string;
  Icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
  tour: string;
}

/** One sidebar link. `homeActive` keeps Home highlighted while a card-launched
 *  page (Interview, Practice) is open, so those pages read as "inside Home"
 *  rather than orphaned. */
function NavItem({ item, homeActive }: { item: NavEntry; homeActive: boolean }) {
  return (
    <NavLink
      to={item.to}
      data-tour={item.tour}
      className={({ isActive }) => {
        const active = isActive || (item.to === '/home' && homeActive);
        return `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
          active
            ? 'bg-indigo-500/10 text-white'
            : 'text-neutral-400 hover:translate-x-0.5 hover:bg-white/5 hover:text-neutral-200'
        }`;
      }}
    >
      {({ isActive }) => {
        const active = isActive || (item.to === '/home' && homeActive);
        return (
          <>
            <span
              className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-indigo-400 transition-all duration-200 ${
                active ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <item.Icon className="h-[18px] w-[18px]" />
            {item.label}
          </>
        );
      }}
    </NavLink>
  );
}
