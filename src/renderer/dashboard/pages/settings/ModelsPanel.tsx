import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings } from '@shared/types';
import { FLAGS } from '@shared/flags';
import { CLOUD_PROVIDERS, modelLabel, parseModelId, qualifyModel, type CloudProviderId } from '@shared/providers';
import { Badge, Button, Card, Dropdown, Field, TextInput, type DropdownOption } from '../../../components/ui';
import { ChevronRightIcon } from '../../../components/icons';
import { addKeyProvider, pickerRows, type AccountModels } from '../../../lib/modelChoice';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsSection } from './sections';
import { PRESET_OPTIONS, PresetPicker, ProviderKeyBlock, ProviderTiles } from './ProviderSetup';

/**
 * One row of the per-task table. `chat` tasks can run on any provider with a
 * key; the rest (embeddings, realtime transcription, speech) have no seam yet
 * and stay on OpenAI — the row says so instead of offering a dropdown that
 * would lie.
 */
const MODEL_FIELDS: { key: string; label: string; hint: string; chat: boolean; suggest: string[] }[] = [
  {
    key: 'answer',
    label: 'Live answer',
    hint: 'Writes the cue that streams into the Cue Card (latency matters).',
    chat: true,
    suggest: [],
  },
  {
    key: 'coding',
    label: 'Coding solver',
    hint: 'Solves coding problems from clipboard text or a screenshot (reasoning model recommended).',
    chat: true,
    suggest: [],
  },
  {
    key: 'classify',
    label: 'Question detection',
    hint: 'Classifies what was said — runs constantly, so cheapest tier.',
    chat: true,
    suggest: [],
  },
  {
    key: 'parsing',
    label: 'Document parsing',
    hint: 'Extracts structured JSON from résumés, job descriptions, and notes.',
    chat: true,
    suggest: [],
  },
  {
    key: 'mock',
    label: 'Mock interviewer',
    hint: 'Asks the questions in Practice sessions.',
    chat: true,
    suggest: [],
  },
  ...(FLAGS.jobSearch
    ? [{ key: 'tailor', label: 'Resume tailoring', hint: 'Rewrites a résumé against a job description.', chat: true, suggest: [] }]
    : []),
  {
    key: 'embedding',
    label: 'Embeddings (retrieval)',
    hint: 'Vectorizes your documents and each question for grounding.',
    chat: false,
    suggest: ['text-embedding-3-small', 'text-embedding-3-large'],
  },
  ...(FLAGS.voice
    ? [
        {
          key: 'tts',
          label: 'Voice output',
          hint: 'Speaks answers aloud.',
          chat: false,
          suggest: ['gpt-4o-mini-tts'],
        },
      ]
    : []),
];


export function ModelsPanel() {
  const { settings, load } = useSettingsStore();
  const meta = settingsSection('models');
  const [provider, setProvider] = useState<CloudProviderId>('openai');
  const keyBlock = useRef<HTMLDivElement>(null);

  const keyed = CLOUD_PROVIDERS.filter((p) => settings?.providerKeys?.[p.id]).length;

  // "Add key" from a task picker: select that provider's tile and bring the key
  // field into view — the picker never stores a placeholder value.
  const jumpToKey = (p: CloudProviderId) => {
    setProvider(p);
    window.setTimeout(() => keyBlock.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  };

  return (
    <>
      <PanelHeader
        title={meta.title}
        blurb={meta.blurb}
        aside={
          keyed > 0 ? (
            <Badge tone="green">{keyed === 1 ? '1 provider' : `${keyed} providers`} configured</Badge>
          ) : (
            <Badge tone="amber">no key yet</Badge>
          )
        }
      />
      <PanelBody>
        {/* The OpenAI key UI lives here now, so the tour's "your key" step rings
            this card. The tiles, key block and preset are shared with the
            onboarding AI step (ProviderSetup.tsx). */}
        <Card data-tour="settings-key">
          <h3 className="mb-1 font-medium">Providers</h3>
          <p className="mb-4 text-sm text-neutral-400">
            BrainCue has no account of its own — every call is billed to your key with the provider
            you choose. Pick a provider to add or test its key; keys are encrypted by your OS and never
            leave the background process.
          </p>
          <ProviderTiles settings={settings} selected={provider} onSelect={setProvider} />

          <div ref={keyBlock} className="mt-4 border-t border-white/5 pt-4">
            {settings && <ProviderKeyBlock key={provider} provider={provider} settings={settings} onSaved={load} />}
          </div>
        </Card>

        {settings && <ModelsCard settings={settings} onSaved={load} onAddKey={jumpToKey} />}
      </PanelBody>
    </>
  );
}

const CUSTOM_OPENROUTER = 'custom:openrouter';

function ModelsCard({
  settings,
  onSaved,
  onAddKey,
}: {
  settings: AppSettings;
  onSaved: () => Promise<void>;
  onAddKey: (p: CloudProviderId) => void;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>(settings.models ?? {});
  const [preset, setPreset] = useState(settings.modelPreset ?? 'balanced');
  // Model ids each configured provider's key can see, merged under the catalog
  // by the picker. Loaded on mount and whenever a key is added or removed.
  const [account, setAccount] = useState<AccountModels>({});
  const [loadingList, setLoadingList] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Tasks whose picker is showing the free-text OpenRouter id field.
  const [customFor, setCustomFor] = useState<Record<string, boolean>>({});
  // Keys the user edited in THIS card since the last sync — Save only writes these,
  // so a stale page can't silently revert overrides written elsewhere (the Cue
  // Card's picker persists models.answer/coding while a session runs).
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

  const keyedChat = CLOUD_PROVIDERS.filter(
    (p) => p.capabilities.includes('chat') && settings.providerKeys?.[p.id],
  ).map((p) => p.id);
  const keyedSignature = keyedChat.join(',');

  /** Ask every configured provider for its model list, in parallel. One
   *  provider failing (expired key, network) must not hide the others'
   *  lists, so failures are collected into the status line instead. */
  const loadLists = async () => {
    if (!keyedChat.length) {
      setAccount({});
      return;
    }
    setLoadingList(true);
    const results = await Promise.allSettled(keyedChat.map((p) => api.settings.listProviderModels(p)));
    const next: AccountModels = {};
    const errors: string[] = [];
    results.forEach((r, i) => {
      const p = keyedChat[i];
      if (r.status === 'fulfilled') next[p] = r.value;
      else errors.push(`${CLOUD_PROVIDERS.find((x) => x.id === p)?.name ?? p}: ${(r.reason as Error).message}`);
    });
    setAccount(next);
    setStatus(errors.length ? `Could not list models — ${errors.join(' · ')}` : null);
    setLoadingList(false);
  };
  useEffect(() => {
    void loadLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyedSignature]);

  const setOverride = (key: string, v: string) => {
    dirty.current.add(key);
    setOverrides((o) => ({ ...o, [key]: v }));
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
    setCustomFor({});
    await api.settings.set({ models: {} });
    await onSaved();
    setStatus('Reset to defaults.');
  };

  // Non-chat rows (embeddings, speech) stay on OpenAI and offer their known
  // ids as suggestions; the field is free text for anything newer.
  const nonChatOptions = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const f of MODEL_FIELDS) if (!f.chat) map[f.key] = f.suggest;
    return map;
  }, []);

  /** Rows for a chat task: the default first, then every provider's catalog
   *  (recommended picks first, the rest after, then what the key can see
   *  beyond the catalog; keyless providers collapse to "Add key"), then the
   *  free-text OpenRouter entry when that key exists. */
  const chatRows = (key: string, def: string, current: string): DropdownOption[] => {
    const rows: DropdownOption[] = [
      { value: '', label: `Default — ${modelLabel(def)}`, description: 'From the preset' },
      ...pickerRows(key, settings.providerKeys, current, { addKeyDisabled: false }, account),
    ];
    if (settings.providerKeys?.openrouter) {
      rows.push({
        value: CUSTOM_OPENROUTER,
        label: 'Custom model id…',
        description: 'Any id from openrouter.ai/models',
        group: 'OpenRouter',
      });
    }
    return rows;
  };

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">Models per task</h3>
        <Button variant="ghost" onClick={loadLists} loading={loadingList} disabled={!keyedChat.length}>
          Refresh model lists
        </Button>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        Pick a preset, or override any single task below. Every dropdown lists every model from each
        provider you have a key for — ★ marks the ones suited to that task — plus whatever else your
        key can see. Non-OpenAI picks are stored as <span className="font-mono">provider/model</span>.
      </p>

      {/* Cost/quality preset — sets the per-task defaults; overrides below still win. */}
      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-medium text-neutral-400">Preset</span>
        <PresetPicker value={preset} customized={customized} onSelect={(p) => void selectPreset(p)} />
        <p className="mt-1.5 text-xs text-neutral-500">
          The live answer &amp; question detection stay on fast, non-reasoning models in every preset
          (even “Best”) — a reasoning model there would add latency without helping. “Best” reserves
          a reasoning model for the coding solver.
        </p>
      </div>

      <div className="space-y-4">
        {MODEL_FIELDS.map((f) => {
          const def = settings.modelDefaults?.[f.key] ?? '';
          const cur = overrides[f.key] ?? '';
          if (!f.chat) {
            return (
              <Field key={f.key} label={f.label} hint={`${f.hint} OpenAI only. Default: ${def}`}>
                <ModelPicker
                  value={cur}
                  placeholder={`Default (${def})`}
                  options={nonChatOptions[f.key]}
                  onChange={(v) => setOverride(f.key, v)}
                />
              </Field>
            );
          }
          const custom = !!customFor[f.key];
          const parsed = cur ? parseModelId(cur) : null;
          const rows = chatRows(f.key, def, cur);
          const known = rows.some((r) => r.value === cur);
          return (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Dropdown
                value={custom ? CUSTOM_OPENROUTER : cur}
                options={rows}
                buttonLabel={custom ? 'Custom OpenRouter id' : cur ? (known ? undefined : modelLabel(cur)) : undefined}
                onChange={(v) => {
                  const addKey = addKeyProvider(v);
                  if (addKey) return onAddKey(addKey);
                  if (v === CUSTOM_OPENROUTER) {
                    setCustomFor((c) => ({ ...c, [f.key]: true }));
                    if (!parsed || parsed.provider !== 'openrouter') setOverride(f.key, '');
                    return;
                  }
                  setCustomFor((c) => ({ ...c, [f.key]: false }));
                  setOverride(f.key, v);
                }}
              />
              {custom && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-neutral-500">openrouter/</span>
                  <TextInput
                    autoFocus
                    value={parsed?.provider === 'openrouter' ? parsed.model : ''}
                    placeholder="vendor/model-name"
                    onChange={(e) => {
                      const id = e.target.value.trim();
                      setOverride(f.key, id ? qualifyModel('openrouter', id) : '');
                    }}
                    className="font-mono text-xs"
                  />
                </div>
              )}
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

/** A combobox for picking an OpenAI-only model: type a custom id, or open a
 *  scrollable list of the suggested + account models (filtered by what you've typed). */
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
