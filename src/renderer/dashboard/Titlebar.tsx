import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { LogoMark } from '../components/Logo';
import {
  HelpIcon,
  WinMinimizeIcon,
  WinMaximizeIcon,
  WinRestoreIcon,
  CloseIcon,
} from '../components/icons';

/** Custom window titlebar for the frameless dashboard (titleBarStyle: 'hidden').
 *  The bar is the OS drag region; the controls opt out and drive the window via
 *  window:* IPC. Close hides the window to the tray (the app keeps running).
 *
 *  Help lives here rather than in the sidebar for one reason: it must be
 *  reachable from every page, including the ones launched from Home that
 *  replace the nav's context. A "?" in the window chrome is also where people
 *  already look for it. */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);
  const navigate = useNavigate();
  const onHelp = useLocation().pathname === '/help';

  useEffect(() => {
    void api.window.isMaximized().then((s) => setMaximized(s.maximized));
    return api.events.onWindowMaximized((p) => setMaximized(p.maximized));
  }, []);

  return (
    <div className="app-drag flex h-9 shrink-0 items-center justify-between border-b border-white/5 bg-neutral-950/80 pl-3 pr-0 backdrop-blur">
      <div className="flex items-center gap-2 text-neutral-400">
        <LogoMark className="h-4 w-4 rounded-[22%]" />
        <span className="text-xs font-medium tracking-tight">BrainCue</span>
      </div>

      <div className="app-no-drag flex h-full items-stretch">
        <button
          type="button"
          aria-label="Help and FAQ"
          title="Help & FAQ"
          data-tour="titlebar-help"
          aria-current={onHelp ? 'page' : undefined}
          onClick={() => navigate('/help')}
          className={`flex w-12 items-center justify-center transition-colors hover:bg-white/10 hover:text-neutral-100 ${
            onHelp ? 'text-indigo-300' : 'text-neutral-400'
          }`}
        >
          <HelpIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => void api.window.minimize()}
          className="flex w-12 items-center justify-center text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
        >
          <WinMinimizeIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => api.window.maximizeToggle().then((s) => setMaximized(s.maximized))}
          className="flex w-12 items-center justify-center text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
        >
          {maximized ? <WinRestoreIcon className="h-4 w-4" /> : <WinMaximizeIcon className="h-4 w-4" />}
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => void api.window.close()}
          className="flex w-12 items-center justify-center text-neutral-400 transition-colors hover:bg-red-600 hover:text-white"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
