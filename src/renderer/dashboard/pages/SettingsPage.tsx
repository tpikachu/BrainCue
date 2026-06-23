import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTourStore } from '../../store/useTourStore';
import { api } from '../../lib/api';
import type { AppSettings } from '@shared/types';
import { SHORTCUT_DEFS } from '@shared/shortcuts';
import { Badge, Button, Card, Field, Page, Switch, TextInput } from '../../components/ui';
import { EyeIcon, EyeOffIcon, PlayIcon } from '../../components/icons';

const MODEL_FIELDS: { key: string; label: string; hint: string; suggest: string[] }[] = [
  {
    key: 'answer',
    label: 'Answer generation',
    hint: 'Main model that writes interview answers (streamed).',
    suggest: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  },
  {
    key: 'parsing',
    label: 'Resume / JD parsing',
    hint: 'Extracts structured JSON from documents.',
    suggest: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  },
  {
    key: 'classify',
    label: 'Question detection',
    hint: 'Classifies interviewer utterances.',
    suggest: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1'],
  },
  {
    key: 'embedding',
    label: 'Embeddings (retrieval)',
    hint: 'Vectorizes profile chunks + queries for RAG.',
    suggest: ['text-embedding-3-small', 'text-embedding-3-large'],
  },
  {
    key: 'transcription',
    label: 'Speech-to-text',
    hint: 'Transcribes microphone audio.',
    suggest: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  },
];

export default function SettingsPage() {
  const { settings, load, saveApiKey, clearApiKey, testApiKey } = useSettingsStore();
  const startTour = useTourStore((s) => s.start);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Local mirror so the switch updates instantly (optimistic), then reconciles.
  const [privacyOn, setPrivacyOn] = useState(true);
  const [privacyBusy, setPrivacyBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (settings) setPrivacyOn(settings.privacyMode);
  }, [settings]);

  // Keep the switch in sync when privacy is toggled elsewhere (global shortcut
  // Ctrl+Shift+H or the overlay button), not just from this page.
  useEffect(() => {
    return api.events.onPrivacyChanged((p) => setPrivacyOn((p as { enabled: boolean }).enabled));
  }, []);

  const onSave = async () => {
    setSaving(true);
    setStatus('Saving…');
    try {
      await saveApiKey(key);
      setKey('');
      setStatus('Saved. The key is encrypted via your OS secure storage.');
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setStatus('Testing…');
    const res = await testApiKey();
    setStatus(res.ok ? `OK — reachable (e.g. ${res.model}).` : `Failed: ${res.error}`);
    setTesting(false);
  };

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

  return (
    <Page title="Settings" width="max-w-2xl">
      <Card className="mb-5">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="font-medium">OpenAI API Key</h3>
          {settings?.apiKeyPresent ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not set</Badge>}
        </div>
        <p className="mb-4 text-sm text-neutral-400">
          Stored encrypted in the main process and never exposed to this window.
        </p>
        <Field label="API key">
          <div className="flex gap-2">
            <TextInput
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
            />
            <Button variant="primary" onClick={onSave} disabled={!key} loading={saving}>
              Save
            </Button>
          </div>
        </Field>
        <div className="mt-3 flex gap-2">
          <Button onClick={onTest} loading={testing}>
            Test connection
          </Button>
          <Button variant="ghost" className="text-red-300" onClick={() => clearApiKey()}>
            Clear key
          </Button>
        </div>
        {status && <p className="mt-3 text-sm text-neutral-300">{status}</p>}
      </Card>

      <Card>
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
                  Ctrl+Shift+H
                </span>
              </p>
            </div>
          </div>
          <Switch checked={privacyOn} onChange={setPrivacy} onLabel="Hidden" offLabel="Visible" />
        </div>
        <p className="mt-3 text-sm text-neutral-400">
          When on, <strong>all app windows</strong> (dashboard, overlay, and region selector) are
          excluded from OS screen capture, so they don’t appear when you share your screen in Zoom,
          Google Meet, Teams, or a recording. This only affects screen capture — it does not hide the
          app from your operating system or task manager.
        </p>
        <p className="mt-2 text-xs text-amber-300/80">
          Only use AI assistance where it is permitted. You are responsible for following the rules
          of your interview, exam, or call.
        </p>
      </Card>

      {settings && <ShortcutsCard settings={settings} onSaved={load} />}

      {settings && <ModelsCard settings={settings} onSaved={load} />}

      <Card className="mt-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-medium">Getting started</h3>
            <p className="text-xs text-neutral-500">Replay the guided tour of the app.</p>
          </div>
          <Button onClick={startTour}>
            <PlayIcon /> Replay tour
          </Button>
        </div>
      </Card>
    </Page>
  );
}

function ModelsCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [overrides, setOverrides] = useState<Record<string, string>>(settings.models ?? {});
  const [available, setAvailable] = useState<string[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => setOverrides(settings.models ?? {}), [settings.models]);

  const options = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const f of MODEL_FIELDS) {
      map[f.key] = Array.from(new Set([...f.suggest, ...available]));
    }
    return map;
  }, [available]);

  const refreshList = async () => {
    setLoadingList(true);
    setStatus(null);
    try {
      const list = await api.settings.listModels();
      setAvailable(list);
      setStatus(`Loaded ${list.length} models from your account.`);
    } catch (e) {
      setStatus(`Could not list models: ${(e as Error).message}`);
    } finally {
      setLoadingList(false);
    }
  };

  const save = async () => {
    // Persist only non-empty overrides; empty means "use default".
    const clean = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v && v.trim()),
    );
    await api.settings.set({ models: clean });
    await onSaved();
    setStatus('Models saved.');
  };

  const reset = async () => {
    setOverrides({});
    await api.settings.set({ models: {} });
    await onSaved();
    setStatus('Reset to defaults.');
  };

  return (
    <Card className="mt-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">OpenAI Models</h3>
        <Button onClick={refreshList} loading={loadingList}>
          {available.length ? 'Refresh model list' : 'Load my models'}
        </Button>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        Choose a model per task, or leave blank to use the default. Pick from the dropdown or type a
        model id. “Load my models” fetches what your API key has access to.
      </p>

      <div className="space-y-4">
        {MODEL_FIELDS.map((f) => {
          const def = settings.modelDefaults?.[f.key] ?? '';
          return (
            <Field key={f.key} label={f.label} hint={`${f.hint} Default: ${def}`}>
              <TextInput
                list={`models-${f.key}`}
                value={overrides[f.key] ?? ''}
                placeholder={`Default (${def})`}
                onChange={(e) => setOverrides((o) => ({ ...o, [f.key]: e.target.value }))}
              />
              <datalist id={`models-${f.key}`}>
                {options[f.key].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={save}>
          Save models
        </Button>
        <Button variant="ghost" onClick={reset}>
          Reset to defaults
        </Button>
      </div>
      {status && <p className="mt-3 text-sm text-neutral-300">{status}</p>}
    </Card>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** Pretty-print an Electron accelerator for display (e.g. "Ctrl + Shift + A"). */
function formatAccel(accel: string): string {
  const map: Record<string, string> = {
    CommandOrControl: IS_MAC ? '⌘' : 'Ctrl',
    Command: '⌘',
    Control: 'Ctrl',
    Alt: IS_MAC ? '⌥' : 'Alt',
    Option: '⌥',
    Shift: IS_MAC ? '⇧' : 'Shift',
    Super: 'Win',
  };
  return accel
    .split('+')
    .map((p) => map[p] ?? p)
    .join(' + ');
}

/** Convert a keydown into the key portion of an Electron accelerator, or null
 *  if only modifier keys are held (keep listening). */
function keyFromEvent(e: React.KeyboardEvent): string | null {
  const k = e.key;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) return null;
  if (k === ' ') return 'Space';
  if (k.startsWith('Arrow')) return k.slice(5); // ArrowUp -> Up
  const named: Record<string, string> = {
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  if (named[k]) return named[k];
  if (/^F\d{1,2}$/.test(k)) return k; // function keys
  if (k.length === 1) return k.toUpperCase();
  return null;
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
    <Card className="mt-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">Keyboard Shortcuts</h3>
        <Badge tone="blue">global</Badge>
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
