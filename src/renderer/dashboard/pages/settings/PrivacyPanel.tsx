import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import { Badge, Button, Card, Switch } from '../../../components/ui';
import { EyeIcon, EyeOffIcon, RefreshIcon, TrashIcon } from '../../../components/icons';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsSection } from './sections';
import { formatAccel } from './accel';

export function PrivacyPanel() {
  const { settings, load } = useSettingsStore();
  const meta = settingsSection('privacy');

  // Local mirror so the switch updates instantly (optimistic), then reconciles.
  const [privacyOn, setPrivacyOn] = useState(true);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  // setContentProtection is a silent no-op on Linux — be honest about it.
  const [privacySupported, setPrivacySupported] = useState(true);
  useEffect(() => {
    void api.privacy.get().then((p) => setPrivacySupported(p.supported));
  }, []);
  const [hideTaskbar, setHideTaskbar] = useState(false);

  useEffect(() => {
    if (settings) {
      setPrivacyOn(settings.privacyMode);
      setHideTaskbar(settings.hideTaskbarIcon);
    }
  }, [settings]);

  // Keep the switch in sync when privacy is toggled elsewhere (the global
  // shortcut or the tray), not just from this page.
  useEffect(() => {
    return api.events.onPrivacyChanged((p) => setPrivacyOn((p as { enabled: boolean }).enabled));
  }, []);

  const setPrivacy = async (next: boolean) => {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    setPrivacyOn(next); // optimistic
    try {
      const res = (await api.privacy.set(next)) as { enabled: boolean };
      setPrivacyOn(res.enabled); // reconcile with truth
      await load();
    } catch {
      setPrivacyOn(!next); // revert on failure
    } finally {
      setPrivacyBusy(false);
    }
  };

  const setHideTaskbarIcon = async (next: boolean) => {
    setHideTaskbar(next); // optimistic
    try {
      await api.settings.set({ hideTaskbarIcon: next });
      await load();
    } catch {
      setHideTaskbar(!next); // revert on failure
    }
  };

  return (
    <>
      <PanelHeader
        title={meta.title}
        blurb={meta.blurb}
        aside={privacyOn ? <Badge tone="green">hidden from capture</Badge> : <Badge tone="amber">visible to capture</Badge>}
      />
      <PanelBody>
        <Card data-tour="settings-privacy">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                  privacyOn ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {privacyOn ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
              </span>
              <div>
                <h3 className="font-medium">Privacy Mode</h3>
                <p className="text-xs text-neutral-500">
                  {privacyOn
                    ? 'Hidden from screen sharing & recording'
                    : 'Visible to screen sharing & recording'}
                  <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                    {formatAccel(settings?.shortcuts['privacy:toggle'] ?? 'CommandOrControl+Shift+H')}
                  </span>
                </p>
              </div>
            </div>
            <Switch checked={privacyOn} onChange={setPrivacy} onLabel="Hidden" offLabel="Visible" />
          </div>
          {!privacySupported && (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              ⚠ Privacy Mode has <strong>no effect on Linux</strong> — the operating system doesn’t
              support excluding windows from capture, so BrainCue <strong>will be visible</strong> in
              screen shares and recordings regardless of this switch.
            </p>
          )}
          <p className="mt-3 text-sm text-neutral-400">
            When on, <strong>all app windows</strong> (dashboard, Cue Card, and region selector) are
            excluded from OS screen capture, so they don’t appear when you share your screen in Zoom,
            Google Meet, Teams, or a recording. This only affects screen capture — it does not hide the
            app from your operating system or task manager.
          </p>

          <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
            <div>
              <h3 className="font-medium">Hide icon from the taskbar</h3>
              <p className="mt-0.5 text-xs text-neutral-500">
                Keep BrainCue off the Windows taskbar. It stays reachable from the system tray and the
                Cue Card. (Doesn’t hide it from Task Manager.)
              </p>
            </div>
            <Switch checked={hideTaskbar} onChange={setHideTaskbarIcon} onLabel="Hidden" offLabel="Shown" />
          </div>

          {/* What BrainCue remembers is TWO switches, and they used to live in
              two places: this one for conversation summaries, another on the
              Memory page for long-term memory. Both read as "remembering", so
              having them apart made it impossible to tell which one you had just
              turned off. They are together on Memory now; this points there. */}
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
            <div>
              <h3 className="font-medium">What BrainCue remembers</h3>
              <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-neutral-500">
                Conversation summaries and long-term memory are two separate switches, and both live
                in Memory — along with everything currently remembered and the review queue.
              </p>
            </div>
            <Link to="/memory">
              <Button>Open Memory</Button>
            </Link>
          </div>
        </Card>

        <DangerZoneCard onChanged={load} />
      </PanelBody>
    </>
  );
}

/** Destructive actions. Both are confirmed by a native dialog in the main process,
 *  so nothing is wiped without explicit consent. */
function DangerZoneCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<'reset' | 'wipe' | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const resetSettings = async () => {
    setBusy('reset');
    setStatus(null);
    try {
      const { reset } = await api.settings.resetApp();
      await onChanged();
      setStatus(reset ? 'All settings were reset to defaults.' : null);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const wipeData = async () => {
    setBusy('wipe');
    setStatus(null);
    try {
      const { wiped } = await api.data.wipeAll();
      await onChanged();
      setStatus(wiped ? 'All user data was removed (API key, profiles, sessions).' : null);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-red-900/40">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium text-red-300">Danger zone</h3>
        <Badge tone="amber">irreversible</Badge>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        These actions cannot be undone. Each asks for confirmation first.
      </p>

      <div className="divide-y divide-white/5">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm text-neutral-200">Reset app settings</p>
            <p className="text-xs text-neutral-500">
              Restore models, Cue Card, privacy, and shortcuts to factory defaults. Keeps your API key
              and data.
            </p>
          </div>
          <Button variant="default" onClick={resetSettings} loading={busy === 'reset'} disabled={!!busy}>
            <RefreshIcon className="h-4 w-4" /> Reset
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm text-neutral-200">Remove all user data</p>
            <p className="text-xs text-neutral-500">
              Delete the OpenAI API key, every profile, and all interview sessions and reports.
            </p>
          </div>
          <Button variant="danger" onClick={wipeData} loading={busy === 'wipe'} disabled={!!busy}>
            <TrashIcon className="h-4 w-4" /> Delete all
          </Button>
        </div>
      </div>

      {status && <p className="mt-3 text-sm text-neutral-300">{status}</p>}
    </Card>
  );
}
