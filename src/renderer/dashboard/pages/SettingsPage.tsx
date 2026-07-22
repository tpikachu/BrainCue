import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTourStore } from '../../store/useTourStore';
import { api } from '../../lib/api';
import type { AppSettings, CompanionPrefs } from '@shared/types';
import { FLAGS } from '@shared/flags';
import { SHORTCUT_DEFS } from '@shared/shortcuts';
import type { UpdateStatus } from '@shared/ipc';
import { Badge, Button, Card, Field, Page, Select, Switch, TextInput } from '../../components/ui';
import { BUDGET_OPTIONS, COMPANION_PRESENCE_OPTIONS } from '../startFlow';
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  PlayIcon,
  RefreshIcon,
  TrashIcon,
} from '../../components/icons';

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
  {
    key: 'coding',
    label: 'Coding solver',
    hint: 'Solves coding problems from clipboard text or a screenshot (reasoning model recommended).',
    suggest: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'o4-mini'],
  },
];

const PRESET_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'balanced', label: 'Balanced', hint: 'Fast + smart (default)' },
  { value: 'low_cost', label: 'Low cost', hint: 'Cheapest tiers' },
  { value: 'best', label: 'Best', hint: 'Max quality' },
];

/** The engine's capability seam, in the user's words. Every one of these is a
 *  separate provider choice (main/providers/registry.ts) — today they all
 *  resolve to OpenAI, the reference implementation. */
const CAPABILITIES: { label: string; hint: string }[] = [
  { label: 'Answers & cards', hint: 'Generates what appears in the Cue Card' },
  { label: 'Document search', hint: 'Embeds your documents so answers can be grounded' },
  { label: 'Live transcription', hint: 'Turns the conversation into text in real time' },
  { label: 'Voice output', hint: 'Speaks answers aloud' },
  { label: 'Screen reading', hint: 'Reads a captured region of your screen' },
];

/** Providers on the roadmap. Deliberately NOT selectable — none of these are
 *  implemented yet, and offering a dead dropdown would be worse than saying so.
 *  `covers` stays honest: no single provider does all five capabilities, which
 *  is exactly why the choice is per-capability. */
const PLANNED_PROVIDERS: { name: string; covers: string }[] = [
  { name: 'Anthropic', covers: 'Answers & cards, screen reading' },
  { name: 'Google Gemini', covers: 'Answers & cards, document search, screen reading' },
  { name: 'Local (Ollama)', covers: 'Answers & cards, document search — runs on your machine' },
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
  // setContentProtection is a silent no-op on Linux — be honest about it.
  const [privacySupported, setPrivacySupported] = useState(true);
  useEffect(() => {
    void api.privacy.get().then((p) => setPrivacySupported(p.supported));
  }, []);
  const [hideTaskbar, setHideTaskbar] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

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

      {/* Providers — a signpost, not a control. The capability seam exists in
          the engine, but OpenAI is the only implementation registered today, so
          there is genuinely nothing to choose yet. Say that plainly rather than
          shipping a dropdown with one option. */}
      <Card className="mb-5">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="font-medium">Providers</h3>
          <Badge tone="neutral">Coming soon</Badge>
        </div>
        <p className="mb-4 text-sm text-neutral-400">
          BrainCue reaches AI through a provider layer with a separate choice per
          capability — so a cheap model can classify while a stronger one answers. OpenAI is
          the reference implementation today; support for more providers is on the way.
        </p>

        <div className="space-y-1.5">
          {CAPABILITIES.map((c) => (
            <div
              key={c.label}
              title={c.hint}
              className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm text-neutral-300">{c.label}</span>
              <Badge tone="green">OpenAI</Badge>
            </div>
          ))}
        </div>

        <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Planned
        </p>
        <div className="flex flex-wrap gap-2">
          {PLANNED_PROVIDERS.map((p) => (
            <span
              key={p.name}
              title={`Would cover: ${p.covers}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-neutral-900/60 px-3 py-1.5 text-xs text-neutral-400 opacity-70"
            >
              {p.name}
              <span className="rounded-full bg-neutral-800 px-1.5 py-px text-[10px] font-medium text-neutral-400">
                Coming soon
              </span>
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Your key above stays with OpenAI. Each provider will get its own key when it lands.
        </p>
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
      </Card>

      {settings && <ShortcutsCard settings={settings} onSaved={load} />}

      {settings && <ModelsCard settings={settings} onSaved={load} />}

      {FLAGS.companion && settings && <CompanionCard settings={settings} onSaved={load} />}

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

      <UpdatesCard />

      <DangerZoneCard onChanged={load} />
    </Page>
  );
}

const minToTime = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const timeToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Global companion configuration: personality (the ONE persona source —
 *  engine/persona.ts renders it), default posture, a do-not-disturb window,
 *  and the default hard session budget. Per-Space overrides live on each
 *  Space in the Library. */
function CompanionCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [prefs, setPrefs] = useState<CompanionPrefs>(settings.companionPrefs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setPrefs(settings.companionPrefs), [settings.companionPrefs]);

  const dnd = prefs.dnd[0] ?? null;
  const patch = (p: Partial<CompanionPrefs>) => {
    setSaved(false);
    setPrefs((v) => ({ ...v, ...p }));
  };
  const patchPersonality = (p: Partial<CompanionPrefs['personality']>) =>
    patch({ personality: { ...prefs.personality, ...p } });

  const save = async () => {
    setSaving(true);
    try {
      await api.settings.set({ companionPrefs: prefs });
      await onSaved();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-5">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-medium">Companion</h3>
        <Badge tone="amber">Labs</Badge>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        How the companion behaves in every session. A Space can override tone, brevity, humor, and
        posture for sessions grounded in it (Library › Spaces).
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <TextInput
            value={prefs.personality.name}
            onChange={(e) => patchPersonality({ name: e.target.value })}
            placeholder="BrainCue"
          />
        </Field>
        <Field label="Tone">
          <Select
            value={prefs.personality.tone}
            onChange={(e) => patchPersonality({ tone: e.target.value as CompanionPrefs['personality']['tone'] })}
          >
            <option value="warm">Warm</option>
            <option value="neutral">Neutral</option>
            <option value="direct">Direct</option>
          </Select>
        </Field>
        <Field label="Brevity">
          <Select
            value={prefs.personality.brevity}
            onChange={(e) => patchPersonality({ brevity: e.target.value as CompanionPrefs['personality']['brevity'] })}
          >
            <option value="terse">Terse</option>
            <option value="normal">Normal</option>
            <option value="chatty">Chatty</option>
          </Select>
        </Field>
        <Field label="Default presence">
          <Select
            value={prefs.presence}
            onChange={(e) => patch({ presence: e.target.value as CompanionPrefs['presence'] })}
          >
            {COMPANION_PRESENCE_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} — {p.desc}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default session budget">
          <Select
            value={prefs.budgetCents === null ? '' : String(prefs.budgetCents)}
            onChange={(e) =>
              patch({ budgetCents: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            {BUDGET_OPTIONS.map((b) => (
              <option key={b.label} value={b.value === null ? '' : String(b.value)}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
        <div>
          <h4 className="text-sm font-medium">Light humor</h4>
          <p className="mt-0.5 text-xs text-neutral-500">Allow the occasional aside when it fits.</p>
        </div>
        <Switch
          checked={prefs.personality.humor}
          onChange={(v) => patchPersonality({ humor: v })}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
        <div>
          <h4 className="text-sm font-medium">Do not disturb</h4>
          <p className="mt-0.5 text-xs text-neutral-500">
            No automatic contributions in this window (summons still answer). Spans midnight if the
            end is earlier than the start.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dnd && (
            <>
              <input
                type="time"
                value={minToTime(dnd.startMin)}
                onChange={(e) => patch({ dnd: [{ ...dnd, startMin: timeToMin(e.target.value) }] })}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
              />
              <span className="text-xs text-neutral-500">to</span>
              <input
                type="time"
                value={minToTime(dnd.endMin)}
                onChange={(e) => patch({ dnd: [{ ...dnd, endMin: timeToMin(e.target.value) }] })}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
              />
            </>
          )}
          <Switch
            checked={!!dnd}
            onChange={(v) => patch({ dnd: v ? [{ startMin: 1320, endMin: 420 }] : [] })}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-3 border-t border-white/5 pt-4">
        {saved && <span className="text-xs text-green-400">Saved ✓</span>}
        <Button variant="primary" onClick={() => void save()} loading={saving}>
          Save companion settings
        </Button>
      </div>
    </Card>
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
    <Card className="mt-5">
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
    <Card className="mt-5 border-red-900/40">
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

function ModelsCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [overrides, setOverrides] = useState<Record<string, string>>(settings.models ?? {});
  const [preset, setPreset] = useState(settings.modelPreset ?? 'balanced');
  const [available, setAvailable] = useState<string[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Keys the user edited in THIS card since the last sync — Save only writes these,
  // so a stale page can't silently revert overrides written elsewhere (the Cue
  // Card's coding panel persists models.coding while a session runs).
  const dirty = useRef(new Set<string>());

  useEffect(() => {
    setOverrides(settings.models ?? {});
    dirty.current.clear();
  }, [settings.models]);
  useEffect(() => setPreset(settings.modelPreset ?? 'balanced'), [settings.modelPreset]);

  // True once a per-task model override diverges from the active preset's table —
  // the config is then "Custom" rather than one of the named presets.
  const customized = Object.entries(overrides).some(
    ([k, v]) => v && v.trim() && v !== (settings.modelDefaults?.[k] ?? ''),
  );

  // Switch the cost/quality preset. Picking one is a clean switch — it clears the
  // per-task overrides, so the config matches the preset (no lingering "Custom").
  const selectPreset = async (p: string) => {
    setPreset(p);
    setOverrides({});
    dirty.current.clear();
    await api.settings.set({ modelPreset: p, models: {} });
    await onSaved();
    setStatus(`Preset: ${PRESET_OPTIONS.find((o) => o.value === p)?.label ?? p}.`);
  };

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
    // Read-modify-write against FRESH settings, touching only the keys edited in
    // this card. Empty means "use default". A whole-map write from a stale page
    // would silently revert overrides written elsewhere while it sat open.
    const fresh = (await api.settings.get()) as AppSettings;
    const merged: Record<string, string> = { ...(fresh.models ?? {}) };
    for (const key of dirty.current) {
      const v = (overrides[key] ?? '').trim();
      if (v) merged[key] = v;
      else delete merged[key];
    }
    await api.settings.set({ models: merged });
    await onSaved();
    setStatus('Models saved.');
  };

  const reset = async () => {
    setOverrides({});
    dirty.current.clear();
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
        Pick a preset, or override any single task below. “Load my models” fetches what your API key
        has access to.
      </p>

      {/* Cost/quality preset — sets the per-task defaults; overrides below still win. */}
      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-medium text-neutral-400">Preset</span>
        <div className="flex gap-1 rounded-lg border border-neutral-700 bg-neutral-950 p-1">
          {PRESET_OPTIONS.map((p) => (
            <button
              key={p.value}
              onClick={() => void selectPreset(p.value)}
              className={`flex-1 rounded-md px-3 py-2 text-center transition-colors ${
                !customized && preset === p.value
                  ? 'bg-indigo-600 text-white'
                  : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              <span className="block text-sm font-medium">{p.label}</span>
              <span className="block text-[10px] opacity-70">{p.hint}</span>
            </button>
          ))}
          {/* Custom: auto-selected when a per-task model override diverges from the
              preset. Not directly selectable — pick a preset or "Reset" to clear it. */}
          <div
            title={
              customized
                ? 'Per-task model overrides differ from the preset. Pick a preset or “Reset to defaults” to clear.'
                : 'Override any task below to create a custom configuration.'
            }
            className={`flex-1 rounded-md px-3 py-2 text-center ${
              customized ? 'bg-indigo-600 text-white' : 'text-neutral-600'
            }`}
          >
            <span className="block text-sm font-medium">Custom</span>
            <span className="block text-[10px] opacity-70">Your overrides</span>
          </div>
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          The live answer &amp; question detection stay on fast, non-reasoning models in every preset
          (even “Best”) — a reasoning model there would add latency without helping. “Best” reserves
          a reasoning model for the coding solver.
        </p>
      </div>

      <div className="space-y-4">
        {MODEL_FIELDS.map((f) => {
          const def = settings.modelDefaults?.[f.key] ?? '';
          return (
            <Field key={f.key} label={f.label} hint={`${f.hint} Default: ${def}`}>
              <ModelPicker
                value={overrides[f.key] ?? ''}
                placeholder={`Default (${def})`}
                options={options[f.key]}
                onChange={(v) => {
                  dirty.current.add(f.key);
                  setOverrides((o) => ({ ...o, [f.key]: v }));
                }}
              />
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

/** A combobox for picking a model: type a custom id, or open a scrollable list of
 *  the suggested + account models (filtered by what you've typed). */
function ModelPicker({
  value,
  placeholder,
  options,
  onChange,
}: {
  value: string;
  placeholder: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const filtered = value.trim()
    ? options.filter((o) => o.toLowerCase().includes(value.trim().toLowerCase()))
    : options;
  return (
    <div className="relative">
      <div className="relative">
        <TextInput
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          className="pr-8"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
          aria-label="Toggle model list"
        >
          <ChevronRightIcon className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-2xl shadow-black/50">
          {filtered.map((m) => (
            <button
              key={m}
              type="button"
              // Prevent the input's onBlur from firing before the click registers.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-white/5 ${
                m === value ? 'text-indigo-300' : 'text-neutral-300'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
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
