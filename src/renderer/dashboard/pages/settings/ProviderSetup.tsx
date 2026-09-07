import { useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings } from '@shared/types';
import { CLOUD_PROVIDERS, cloudProvider, type CloudProviderId } from '@shared/providers';
import { Badge, Button, Field, TextInput } from '../../../components/ui';

/**
 * The provider pieces shared by Settings → Language Models and the
 * onboarding AI step: the tile grid (dot = key stored), the key field for
 * one provider, and the cost/quality preset. Keys are stored in main,
 * encrypted; this window only ever learns a boolean per provider.
 */

export const PRESET_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'balanced', label: 'Balanced', hint: 'Fast + smart (default)' },
  { value: 'low_cost', label: 'Low cost', hint: 'Cheapest tiers' },
  { value: 'best', label: 'Best', hint: 'Max quality' },
];

export function ProviderTiles({
  settings,
  selected,
  onSelect,
}: {
  settings: AppSettings | null;
  selected: CloudProviderId;
  onSelect: (p: CloudProviderId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="tablist" aria-label="Providers">
      {CLOUD_PROVIDERS.map((p) => {
        const has = !!settings?.providerKeys?.[p.id];
        const active = selected === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p.id)}
            className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
              active
                ? 'border-indigo-500/60 bg-indigo-500/10 text-white'
                : 'border-white/5 bg-neutral-950/40 text-neutral-300 hover:border-white/10 hover:bg-white/5'
            }`}
          >
            <span className="truncate">
              {p.name}
              {p.id === 'openai' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-neutral-500">required</span>}
            </span>
            <span
              title={has ? 'Key configured' : 'No key'}
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                has ? 'bg-emerald-400' : 'border border-neutral-600'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The key field for one provider. OpenAI keeps the exact behaviour of the old
 * "OpenAI API Key" card (the store's save/test/clear — it is the same key the
 * embeddings and transcription paths use); the others go through the provider
 * endpoints. Both report the same way: a status line under the buttons.
 */
export function ProviderKeyBlock({
  provider,
  settings,
  onSaved,
}: {
  provider: CloudProviderId;
  settings: AppSettings;
  onSaved: () => Promise<void>;
}) {
  const info = cloudProvider(provider)!;
  const { saveApiKey, clearApiKey, testApiKey } = useSettingsStore();
  const has = !!settings.providerKeys?.[provider];
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const looksOff = key && info.keyPrefix && !key.startsWith(info.keyPrefix);

  const onSave = async () => {
    setSaving(true);
    setStatus('Saving…');
    try {
      if (provider === 'openai') await saveApiKey(key);
      else {
        await api.settings.setProviderKey(provider, key);
        await onSaved();
      }
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
    try {
      const res = provider === 'openai' ? await testApiKey() : await api.settings.testProviderKey(provider);
      setStatus(res.ok ? `OK — reachable${res.model ? ` (e.g. ${res.model})` : ''}.` : `Failed: ${res.error}`);
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const onClear = async () => {
    try {
      if (provider === 'openai') await clearApiKey();
      else {
        await api.settings.clearProviderKey(provider);
        await onSaved();
      }
      setStatus('Key removed.');
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-sm font-medium">{info.name} API Key</h4>
        {has ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not set</Badge>}
        <a
          href={info.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs text-indigo-300 hover:underline"
        >
          Get your API key →
        </a>
      </div>
      <p className="mb-3 text-xs text-neutral-500">
        {provider === 'openai'
          ? 'Required: retrieval (embeddings), cloud transcription, voice and the default models run here.'
          : info.transport === 'openai-compatible'
            ? `Optional extra, reached through ${info.name}’s OpenAI-compatible endpoint. Chosen per task later.`
            : `Optional extra, reached through ${info.name}’s own API. Chosen per task later.`}
      </p>
      <Field label={has ? 'Replace key' : 'API key'}>
        <div className="flex gap-2">
          <TextInput
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={info.keyPrefix ? `${info.keyPrefix}…` : 'Paste your key'}
            autoComplete="off"
          />
          <Button variant="primary" onClick={onSave} disabled={!key} loading={saving}>
            Save
          </Button>
        </div>
      </Field>
      {looksOff && (
        <p className="mt-1 text-xs text-amber-300">
          {info.name} keys usually start with <span className="font-mono">{info.keyPrefix}</span> — double-check
          you pasted the right one.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button onClick={onTest} loading={testing} disabled={!has}>
          Test connection
        </Button>
        <Button variant="ghost" className="text-red-300" onClick={() => void onClear()} disabled={!has}>
          Clear key
        </Button>
      </div>
      {status && <p className="mt-3 text-sm text-neutral-300">{status}</p>}
    </div>
  );
}

/**
 * Balanced / Low cost / Best. `customized` marks the fourth, non-selectable
 * "Custom" cell the Models table shows when a per-task override diverges;
 * onboarding has no table yet and leaves it false.
 */
export function PresetPicker({
  value,
  customized = false,
  onSelect,
}: {
  value: string;
  customized?: boolean;
  onSelect: (preset: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-neutral-700 bg-neutral-950 p-1">
      {PRESET_OPTIONS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onSelect(p.value)}
          className={`flex-1 rounded-md px-3 py-2 text-center transition-colors ${
            !customized && value === p.value ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'
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
            : 'Override any task in Settings → Language Models to create a custom configuration.'
        }
        className={`flex-1 rounded-md px-3 py-2 text-center ${customized ? 'bg-indigo-600 text-white' : 'text-neutral-600'}`}
      >
        <span className="block text-sm font-medium">Custom</span>
        <span className="block text-[10px] opacity-70">Your overrides</span>
      </div>
    </div>
  );
}
