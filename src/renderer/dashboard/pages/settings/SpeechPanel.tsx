import type React from 'react';
import { Link } from 'react-router-dom';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { AppSettings } from '@shared/types';
import { type SttEngine } from '@shared/stt';
import { Badge, Card } from '../../../components/ui';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsPath, settingsSection } from './sections';
import { Dot, LocalModelList } from './LocalModelList';

/** The OpenAI Realtime transcribers. Selecting one writes `models.transcription`
 *  (the same override the Language Models table edits). */
const CLOUD_STT_MODELS: { id: string; name: string; description: string }[] = [
  { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe', description: 'Fast and accurate' },
  { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', description: 'Most accurate' },
];

/**
 * Speech-to-Text: which engine transcribes a live session, and the on-device
 * models. `stt.engine` is the choice; `sttReady` (computed in main) is whether
 * that choice can actually run — cloud needs the OpenAI key, local needs a
 * fully downloaded model — and is what gates Start. The badge in the header is
 * that truth, so choosing Local with nothing downloaded is allowed and visibly
 * "not ready" rather than refused.
 *
 * The engine rows and the model list are shared with the onboarding
 * Transcription step (`EngineRow`, `LocalModelList`).
 */
export function SpeechPanel() {
  const { settings, load } = useSettingsStore();
  const meta = settingsSection('speech');

  if (!settings) return null;
  const { engine, localModelId } = settings.stt;

  const setEngine = async (e: SttEngine) => {
    await api.settings.set({ stt: { engine: e, localModelId } });
    await load();
  };
  const setLocalModel = async (id: string) => {
    await api.settings.set({ stt: { engine, localModelId: id } });
    await load();
  };
  const setCloudModel = async (id: string) => {
    // Read-modify-write against FRESH settings: the override map is shared with
    // the Language Models table, which may have written since this page loaded.
    const fresh = (await api.settings.get()) as AppSettings;
    await api.settings.set({ models: { ...(fresh.models ?? {}), transcription: id } });
    await load();
  };

  const cloudModel = settings.models?.transcription ?? settings.modelDefaults?.transcription ?? '';

  return (
    <>
      <PanelHeader
        title={meta.title}
        blurb={meta.blurb}
        aside={settings.sttReady ? <Badge tone="green">ready</Badge> : <Badge tone="amber">not ready</Badge>}
      />
      <PanelBody>
        <Card>
          <h3 className="mb-3 font-medium">Engine</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <EngineRow
              active={engine === 'cloud'}
              title="Cloud Providers"
              blurb="Bring your own API key."
              onClick={() => void setEngine('cloud')}
            />
            <EngineRow
              active={engine === 'local'}
              title="Local"
              blurb="On-device models. Fully private."
              onClick={() => void setEngine('local')}
            />
          </div>
        </Card>

        {engine === 'cloud' ? (
          <Card>
            <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
              <span className="rounded-md bg-indigo-500/15 px-2.5 py-1 text-xs font-medium text-indigo-200">OpenAI</span>
              <span className="text-xs text-neutral-500">Realtime transcription — the only cloud transcriber today</span>
            </div>
            {!settings.apiKeyPresent && (
              <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                Cloud transcription needs an OpenAI key.{' '}
                <Link to={settingsPath('models')} className="font-medium underline">
                  Add it under Language Models
                </Link>
                .
              </p>
            )}
            <ul className="divide-y divide-white/5">
              {CLOUD_STT_MODELS.map((m) => {
                const active = cloudModel === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => void setCloudModel(m.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-white/5"
                    >
                      <span className="flex items-center gap-3">
                        <Dot on={active} />
                        <span>
                          <span className="block text-sm text-neutral-100">{m.name}</span>
                          <span className="block text-xs text-neutral-500">{m.description}</span>
                        </span>
                      </span>
                      {active ? (
                        <Badge tone="green">Active</Badge>
                      ) : (
                        <span className="text-xs text-neutral-500">Use</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {cloudModel && !CLOUD_STT_MODELS.some((m) => m.id === cloudModel) && (
              <p className="mt-2 text-xs text-neutral-500">
                Currently set to <span className="font-mono">{cloudModel}</span> (from Language Models).
              </p>
            )}
          </Card>
        ) : (
          <Card>
            <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
              <span className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200">NVIDIA</span>
              <span className="text-xs text-neutral-500">Streaming transducers via sherpa-onnx, CPU</span>
            </div>
            <LocalModelList selectedModelId={localModelId} onSelect={setLocalModel} />
          </Card>
        )}
      </PanelBody>
    </>
  );
}

/** One engine choice. Exported for the onboarding Transcription step, which
 *  offers the same two. */
export function EngineRow({
  active,
  title,
  blurb,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  blurb: string;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? 'border-indigo-500/60 bg-indigo-500/10'
          : 'border-white/5 bg-neutral-950/40 hover:border-white/10 hover:bg-white/5'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-neutral-100">{title}</span>
        <span className="block text-xs text-neutral-500">{blurb}</span>
        {children}
      </span>
      {active && (
        <span className="shrink-0 rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-200">
          Active
        </span>
      )}
    </button>
  );
}
