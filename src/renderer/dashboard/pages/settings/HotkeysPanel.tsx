import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings } from '@shared/types';
import { SHORTCUT_DEFS } from '@shared/shortcuts';
import { Badge, Button, Card } from '../../../components/ui';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsSection } from './sections';
import { formatAccel, keyFromEvent } from './accel';

export function HotkeysPanel() {
  const { settings, load } = useSettingsStore();
  const meta = settingsSection('hotkeys');
  return (
    <>
      <PanelHeader title={meta.title} blurb={meta.blurb} aside={<Badge tone="blue">global</Badge>} />
      <PanelBody>{settings && <ShortcutsCard settings={settings} onSaved={load} />}</PanelBody>
    </>
  );
}

/** Editable global-shortcut bindings. Recording captures a real keystroke and
 *  stores it as an Electron accelerator; saving re-registers them live. */
function ShortcutsCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [binds, setBinds] = useState<Record<string, string>>(settings.shortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setBinds(settings.shortcuts), [settings.shortcuts]);

  // Suspend global shortcuts while recording so the keystroke reaches this input
  // rather than firing an already-registered global. Always resume on cleanup.
  useEffect(() => {
    if (recording) void api.settings.suspendShortcuts();
    else void api.settings.resumeShortcuts();
    return () => {
      void api.settings.resumeShortcuts();
    };
  }, [recording]);

  const dirty = useMemo(
    () => SHORTCUT_DEFS.some((d) => (binds[d.id] ?? '') !== (settings.shortcuts[d.id] ?? '')),
    [binds, settings.shortcuts],
  );

  const record = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      setRecording(null);
      return;
    }
    const key = keyFromEvent(e);
    if (!key) return; // waiting for a non-modifier key
    const mods: string[] = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) {
      setStatus('Add at least one modifier (Ctrl/Alt/Shift) so the shortcut works globally.');
      return;
    }
    const accel = [...mods, key].join('+');
    // Warn on a duplicate binding (the OS would give it to whichever registers first).
    const clash = SHORTCUT_DEFS.find((d) => d.id !== id && binds[d.id] === accel);
    setBinds((b) => ({ ...b, [id]: accel }));
    setRecording(null);
    setStatus(clash ? `Note: that combo is also set for “${clash.label}”.` : null);
  };

  const save = async () => {
    setSaving(true);
    setStatus('Saving…');
    try {
      await api.settings.setShortcuts(binds);
      await onSaved();
      setStatus('Shortcuts saved and active.');
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetAll = async () => {
    const { shortcuts } = await api.settings.resetShortcuts();
    setBinds(shortcuts);
    await onSaved();
    setStatus('Shortcuts reset to defaults.');
  };

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">Keyboard Shortcuts</h3>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        These work system-wide, even when the app is in the background. Click a shortcut, then press
        the keys you want (Esc to cancel). Use a modifier like Ctrl, Alt, or Shift.
      </p>

      <div className="space-y-2.5">
        {SHORTCUT_DEFS.map((d) => {
          const isRec = recording === d.id;
          const accel = binds[d.id] ?? '';
          const isDefault = accel === settings.shortcutDefaults[d.id];
          return (
            <div
              key={d.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-white/5 bg-neutral-950/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-neutral-200">{d.label}</p>
                <p className="truncate text-xs text-neutral-500">{d.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onKeyDown={(e) => isRec && record(d.id, e)}
                  onClick={() => setRecording(isRec ? null : d.id)}
                  onBlur={() => isRec && setRecording(null)}
                  className={`min-w-[150px] rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${
                    isRec
                      ? 'animate-pulse border-indigo-500 bg-indigo-500/10 text-indigo-200'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-600'
                  }`}
                >
                  {isRec ? 'Press keys…' : accel ? formatAccel(accel) : 'Unset'}
                </button>
                {!isDefault && !isRec && (
                  <button
                    type="button"
                    title="Reset to default"
                    onClick={() =>
                      setBinds((b) => ({ ...b, [d.id]: settings.shortcutDefaults[d.id] }))
                    }
                    className="text-xs text-neutral-500 hover:text-neutral-300"
                  >
                    reset
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={save} disabled={!dirty} loading={saving}>
          Save shortcuts
        </Button>
        <Button variant="ghost" onClick={resetAll}>
          Reset all to defaults
        </Button>
      </div>
      {status && <p className="mt-3 text-sm text-neutral-300">{status}</p>}
    </Card>
  );
}
