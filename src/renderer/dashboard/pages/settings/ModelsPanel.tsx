import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings, Readiness } from '@shared/types';
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
    label: 'Interview answers',
    hint: 'The live answer to each question, in every session — interviews and meetings (latency matters).',
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
  // Tasks edited in THIS card and not yet confirmed saved, each with its edit's
  // sequence number. Save writes only these, so a stale page can't revert
  // overrides written elsewhere (the Cue Card's chips write answer/coding
  // while a session runs).
  const dirty = useRef(new Map<string, number>());
  const editSeq = useRef(0);

  // Main sends a fresh map with EVERY settings push — a discovery list, a
  // failover, another window's write — even when no override changed. Each
  // one refreshes the tasks not edited here and leaves the edited drafts as
  // they are; resetting the whole draft on it discarded an unsaved choice,
  // and Save then wrote nothing while saying "saved" (M7.2a review, AI-02).
  useEffect(() => {
    const stored = settings.models ?? {};
    setOverrides((draft) => {
      const next: Record<string, string> = { ...stored };
      for (const key of dirty.current.keys()) next[key] = draft[key] ?? '';
      return next;
    });
  }, [settings.models]);
  useEffect(() => setPreset(settings.modelPreset ?? 'balanced'), [settings.modelPreset]);

  // True once a per-task model override diverges from the active preset's table —
  // the config is then "Custom" rather than one of the named presets.
  const customized = Object.entries(overrides).some(
    ([k, v]) => v && v.trim() && v !== (settings.modelDefaults?.[k] ?? ''),
  );
  // Advanced opens by itself when overrides are active, and otherwise stays
  // as the user left it: an incoming snapshot never closes it mid-edit.
  const [advancedOpen, setAdvancedOpen] = useState(customized);
  useEffect(() => {
    if (customized) setAdvancedOpen(true);
  }, [customized]);

  // What the policy picked (provider-aware), and why — from main.
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const loadReadiness = () =>
    api.settings
      .readiness()
      .then(setReadiness)
      .catch(() => setReadiness(null));
  useEffect(() => {
    void loadReadiness();
  }, [settings]);

  // Switch Fast / Balanced / Quality. Explicit per-task overrides are KEPT —
  // they are the user's own choices; an override that cannot run is
  // corrected by the policy (with the reason shown), not silently wiped.
  const selectPreset = async (p: string) => {
    setPreset(p);
    await api.settings.set({ modelPreset: p });
    await onSaved();
    const label = PRESET_OPTIONS.find((o) => o.value === p)?.label ?? p;
    setStatus(customized ? `${label} — your per-task overrides in Advanced still apply.` : `${label}.`);
  };

  const selectProvider = async (p: string) => {
    await api.settings.set({ chatProvider: p === 'auto' ? null : p });
    await onSaved();
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
    dirty.current.set(key, ++editSeq.current);
    setOverrides((o) => ({ ...o, [key]: v }));
  };

  const save = async () => {
    // Only the keys edited in this card, merged by main against the stored
    // map (empty → default). A whole-map write from a stale page would
    // silently revert overrides written elsewhere while it sat open.
    const sent = new Map(dirty.current);
    if (sent.size === 0) {
      setStatus('No model changes to save.');
      return;
    }
    const edits: Record<string, string | null> = {};
    for (const key of sent.keys()) edits[key] = (overrides[key] ?? '').trim() || null;
    try {
      await api.settings.set({ modelOverrides: edits });
    } catch (e) {
      setStatus(`Could not save models — ${(e as Error).message}`); // drafts kept, still unsaved
      return;
    }
    // Confirmed: these drafts are now the stored values — unless the task was
    // edited again while the save was in flight; that newer draft stays.
    for (const [key, seq] of sent) if (dirty.current.get(key) === seq) dirty.current.delete(key);
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
    // The policy's pick for this task on the chosen provider with NO
    // override (not the OpenAI preset table — a Claude user's default is a
    // Claude model; not the override either, which this row would clear).
    const effective = settings.autoModels?.[key] ?? settings.effectiveModels?.[key] ?? def;
    const rows: DropdownOption[] = [
      { value: '', label: `Default — ${modelLabel(effective)}`, description: 'Picked for your provider and preference' },
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
        <h3 className="font-medium">Answer model</h3>
        <Button
          variant="ghost"
          onClick={async () => {
            await loadLists();
            setReadiness(await api.settings.refreshModels());
          }}
          loading={loadingList}
          disabled={!keyedChat.length}
        >
          Refresh model lists
        </Button>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        Choose a provider and a preference — BrainCue picks a suitable model for each job (question
        detection, live answers, parsing, the coding solver) from what your key can actually use.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Field label="Provider">
          <Dropdown
            value={settings.chatProvider ?? 'auto'}
            onChange={(v) => void selectProvider(v)}
            options={[
              { value: 'auto', label: 'Automatic', description: 'The first provider you have a key for' },
              ...CLOUD_PROVIDERS.filter((p) => p.capabilities.includes('chat')).map((p) => ({
                value: p.id,
                label: p.name,
                description: settings.providerKeys?.[p.id] ? 'Key stored' : 'No key yet',
                disabled: !settings.providerKeys?.[p.id],
              })),
            ]}
          />
        </Field>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-neutral-400">Preference</span>
          <PresetPicker value={preset} customized={false} onSelect={(p) => void selectPreset(p)} />
        </div>
      </div>
      {readiness && (
        <div className="mb-4 rounded-lg border border-white/5 bg-neutral-950/60 px-3 py-2 text-xs">
          <p className="text-neutral-300">{readiness.chat.explanation}</p>
          {readiness.chat.notice && <p className="mt-1 text-amber-300">{readiness.chat.notice}</p>}
          {readiness.chat.problem && (
            <p className="mt-1 text-red-300">
              {readiness.chat.problem} {readiness.chat.action}
            </p>
          )}
          <p className="mt-1 text-neutral-500">
            Question detection: {modelLabel(settings.effectiveModels?.classify ?? '')}. Live tasks always run
            with the lowest reasoning effort the model allows — first-token time matters most there.
          </p>
        </div>
      )}

      <details className="group" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary className="mb-3 cursor-pointer select-none text-sm font-medium text-neutral-300">
          Advanced — choose a model per task{customized ? ' (overrides active)' : ''}
        </summary>
        <p className="mb-4 text-sm text-neutral-400">
          An override wins over the automatic pick while it can run; if its provider has no key or your
          account no longer lists it, the automatic pick is used and the reason is shown above. Every
          dropdown lists each provider you have a key for — ★ marks the ones suited to that task. Non-OpenAI
          picks are stored as <span className="font-mono">provider/model</span>.
        </p>

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
      </details>
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
