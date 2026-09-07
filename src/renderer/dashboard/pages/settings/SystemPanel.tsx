import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings } from '@shared/types';
import type { UpdateStatus } from '@shared/ipc';
import { Badge, Button, Card, Switch } from '../../../components/ui';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsSection } from './sections';

export function SystemPanel() {
  const { settings, load } = useSettingsStore();
  const meta = settingsSection('system');
  return (
    <>
      <PanelHeader title={meta.title} blurb={meta.blurb} />
      <PanelBody>
        <UpdatesCard />
        <AdvancedCard settings={settings} onSaved={load} />
      </PanelBody>
    </>
  );
}

/** Software updates: current version + a manual check. Auto-update runs in the
 *  background (packaged builds); a downloaded update prompts a restart via the
 *  banner. In dev there's nothing to update against. */
function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    void api.update.getStatus().then(setStatus);
    return api.events.onUpdateStatus(setStatus);
  }, []);

  const label: Record<UpdateStatus['state'], string> = {
    idle: 'Up to date as far as we know.',
    checking: 'Checking for updates…',
    available: `Found ${status?.version ? `v${status.version}` : 'an update'} — downloading…`,
    none: 'You’re on the latest version.',
    downloading: `Downloading${typeof status?.percent === 'number' ? ` ${status.percent}%` : '…'}`,
    downloaded: `v${status?.version ?? ''} downloaded — restart to install.`,
    error: `Couldn’t check: ${status?.message ?? 'unknown error'}`,
  };

  const checking = status?.state === 'checking' || status?.state === 'downloading';

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium">Software updates</h3>
          <p className="text-xs text-neutral-500">
            Version <span className="font-mono">{status?.currentVersion ?? '—'}</span>
            {status && status.state !== 'idle' ? ` · ${label[status.state]}` : ''}
          </p>
        </div>
        <Button onClick={() => void api.update.check()} loading={checking} disabled={checking}>
          Check for updates
        </Button>
      </div>
    </Card>
  );
}

/**
 * Advanced — the DB Explorer switch.
 *
 * Separate from the Danger zone on purpose: nothing here destroys anything, so
 * filing it under "irreversible" would either scare people off a legitimate
 * support tool or teach them to ignore that heading. The warning is about what
 * the tool SHOWS, not about damage it does — it reads every table raw,
 * including transcripts and memory, with no redaction.
 */
function AdvancedCard({
  settings,
  onSaved,
}: {
  settings: AppSettings | null;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const on = !!settings?.devDbExplorer;

  const toggle = async (next: boolean) => {
    if (busy) return; // Switch has no disabled state — guard the handler instead
    setBusy(true);
    try {
      await api.settings.set({ devDbExplorer: next });
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">Advanced</h3>
        <Badge tone="neutral">for troubleshooting</Badge>
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-neutral-200">Show the DB Explorer</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Adds a sidebar entry that browses this machine’s database directly — every table, raw
            and unredacted, including full transcripts and everything in Memory. It is a support
            tool for diagnosing a problem, not a feature: turn it on if you have been asked to, or
            if you know what you are looking for. Nothing here is edited or deleted by viewing it.
          </p>
        </div>
        <Switch checked={on} onChange={(v) => void toggle(v)} onLabel="Shown" offLabel="Hidden" />
      </div>
    </Card>
  );
}
