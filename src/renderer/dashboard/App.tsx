import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTourStore } from '../store/useTourStore';
import { Tour, TOUR_STEPS } from './Tour';
import ProfilesPage from './pages/ProfilesPage';
import ProfileEditorPage from './pages/ProfileEditorPage';
import SessionPage from './pages/SessionPage';
import MockPage from './pages/MockPage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import WhatsNewPage from './pages/WhatsNewPage';
import { APP_VERSION } from './changelog';
import {
  MockIcon,
  OverlayIcon,
  ReportIcon,
  SettingsIcon,
  MicIcon,
  UserIcon,
} from '../components/icons';
import { Logo } from '../components/Logo';

const navItems = [
  { to: '/profiles', label: 'Profiles', Icon: UserIcon, tour: 'nav-profiles' },
  { to: '/session', label: 'Live Session', Icon: MicIcon, tour: 'nav-session' },
  { to: '/mock', label: 'Mock Interview', Icon: MockIcon, tour: 'nav-mock' },
  { to: '/reports', label: 'Reports', Icon: ReportIcon, tour: 'nav-reports' },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, tour: 'nav-settings' },
];

export default function App() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const { settings, load: loadSettings } = useSettingsStore();
  const { running, start, stop } = useTourStore();
  const navigate = useNavigate();

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Reflect the overlay's real visibility (it can be toggled from the hotkey,
  // the tray, the overlay's own close button, or a session ending), and let the
  // tray "Settings" item route the dashboard here.
  useEffect(() => {
    void api.overlay.isVisible().then((s) => setOverlayVisible((s as { visible: boolean }).visible));
    const offVis = api.events.onOverlayVisibility((p) =>
      setOverlayVisible((p as { visible: boolean }).visible),
    );
    const offNav = api.events.onNavigate((p) => navigate((p as { path: string }).path));
    return () => {
      offVis();
      offNav();
    };
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

  const toggleOverlay = async () => {
    const { visible } = (await api.overlay.toggle()) as { visible: boolean };
    setOverlayVisible(visible);
  };

  return (
    <div className="flex h-screen bg-gradient-to-b from-neutral-950 to-neutral-900 text-neutral-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-neutral-950/60 p-4">
        <div className="mb-8 flex items-center gap-2.5 px-1">
          <Logo className="h-9 w-9" />
          <div className="leading-tight">
            <h1 className="text-sm font-semibold">Interview</h1>
            <p className="text-xs text-neutral-500">Assistant</p>
          </div>
        </div>
        <nav className="space-y-1">
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              data-tour={n.tour}
              className={({ isActive }) =>
                `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-500/10 text-white'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-indigo-400" />
                  )}
                  <n.Icon className="h-[18px] w-[18px]" />
                  {n.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <button
          onClick={toggleOverlay}
          data-tour="overlay-toggle"
          title="Show/hide the floating answer overlay (Ctrl+Shift+Space)"
          className={`mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
            overlayVisible
              ? 'bg-indigo-500/10 text-white'
              : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
          }`}
        >
          <OverlayIcon className="h-[18px] w-[18px]" />
          {overlayVisible ? 'Hide overlay' : 'Show overlay'}
        </button>

        <p className="mt-auto px-2 text-xs leading-relaxed text-neutral-600">
          Use only where AI assistance is allowed. Data stays local; only retrieved
          context is sent to OpenAI.
        </p>
        <NavLink
          to="/whats-new"
          className={({ isActive }) =>
            `mt-2 rounded-md px-2 py-1 text-xs transition-colors ${
              isActive ? 'text-indigo-300' : 'text-neutral-600 hover:text-neutral-400'
            }`
          }
        >
          v{APP_VERSION} · What's new
        </NavLink>
      </aside>

      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/profiles" replace />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/profiles/:id" element={<ProfileEditorPage />} />
          <Route path="/session" element={<SessionPage />} />
          <Route path="/mock" element={<MockPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/whats-new" element={<WhatsNewPage />} />
        </Routes>
      </main>

      {running && <Tour steps={TOUR_STEPS} onClose={finishTour} />}
    </div>
  );
}
