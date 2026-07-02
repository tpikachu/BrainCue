import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTourStore } from '../store/useTourStore';
import { Tour, TOUR_STEPS } from './Tour';
import ProfilesPage from './pages/ProfilesPage';
import ProfileEditorPage from './pages/ProfileEditorPage';
import InterviewPage from './pages/InterviewPage';
import MockPage from './pages/MockPage';
import SparringPage from './pages/SparringPage';
import TailorPage from './pages/TailorPage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import WhatsNewPage from './pages/WhatsNewPage';
import DevDbExplorerPage from './pages/DevDbExplorerPage';
import { Titlebar } from './Titlebar';
import { SidebarStatus } from './SidebarStatus';
import { UpdateBanner } from './UpdateBanner';
import { SavePromptModal } from './SavePromptModal';
import {
  BoltIcon,
  DatabaseIcon,
  MockIcon,
  ReportIcon,
  SettingsIcon,
  MicIcon,
  UploadIcon,
  UserIcon,
} from '../components/icons';
import { Logo } from '../components/Logo';

// Dev-only DB explorer — shown/routed only in unpackaged builds.
const DEV = import.meta.env.DEV;

const navItems = [
  { to: '/profiles', label: 'Profiles', Icon: UserIcon, tour: 'nav-profiles' },
  { to: '/interview', label: 'Interview', Icon: MicIcon, tour: 'nav-session' },
  { to: '/mock', label: 'Mock Interview', Icon: MockIcon, tour: 'nav-mock' },
  { to: '/sparring', label: 'Sparring', Icon: BoltIcon, tour: 'nav-sparring' },
  { to: '/tailor', label: 'Tailor Resume', Icon: UploadIcon, tour: 'nav-tailor' },
  { to: '/reports', label: 'Reports', Icon: ReportIcon, tour: 'nav-reports' },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, tour: 'nav-settings' },
  ...(DEV ? [{ to: '/dev', label: 'DB Explorer', Icon: DatabaseIcon, tour: 'nav-dev' }] : []),
];

export default function App() {
  const { settings, load: loadSettings } = useSettingsStore();
  const { running, start, stop } = useTourStore();
  const navigate = useNavigate();
  const [version, setVersion] = useState('');

  useEffect(() => {
    void api.app.getInfo().then((i) => setVersion(i.version));
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

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
              <span className="text-xs text-neutral-500">Copilot</span>
              {version && (
                <span className="version-pill rounded-full border border-white/10 bg-white/5 px-1.5 py-px text-[10px] font-medium tabular-nums text-neutral-400">
                  v{version}
                </span>
              )}
            </div>
          </div>
        </Link>
        <nav className="space-y-1">
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              data-tour={n.tour}
              className={({ isActive }) =>
                `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
                  isActive
                    ? 'bg-indigo-500/10 text-white'
                    : 'text-neutral-400 hover:translate-x-0.5 hover:bg-white/5 hover:text-neutral-200'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-indigo-400 transition-all duration-200 ${
                      isActive ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                  <n.Icon className="h-[18px] w-[18px]" />
                  {n.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <SidebarStatus />
      </aside>

      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/profiles" replace />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/profiles/:id" element={<ProfileEditorPage />} />
          <Route path="/interview" element={<InterviewPage />} />
          <Route path="/mock" element={<MockPage />} />
          <Route path="/sparring" element={<SparringPage />} />
          <Route path="/tailor" element={<TailorPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/whats-new" element={<WhatsNewPage />} />
          {DEV && <Route path="/dev" element={<DevDbExplorerPage />} />}
        </Routes>
      </main>
      </div>

      {/* Global: sessions can be started from several pages and stopped from the
          Cue Card — the save-or-discard prompt must appear wherever the user is. */}
      <SavePromptModal />

      {running && <Tour steps={TOUR_STEPS} onClose={finishTour} />}
    </div>
  );
}
