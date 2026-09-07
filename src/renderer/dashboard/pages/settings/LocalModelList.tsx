import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { api } from '../../../lib/api';
import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import { LOCAL_STT_MODELS, formatBytes, type LocalSttModel } from '@shared/stt';
import { Badge, Button } from '../../../components/ui';
import { TrashIcon } from '../../../components/icons';

const TERMINAL = new Set<SttDownloadProgress['state']>(['done', 'error', 'cancelled']);

/**
 * The on-device model catalog with its install state and any download in
 * flight. Seeded from `stt:list-models` (a download started before this
 * mounted shows its progress) and driven by `EVENTS.sttDownloadProgress`.
 * Reloads settings when a download ends, because `sttReady` may have flipped.
 *
 * Shared by the Speech-to-Text panel, the onboarding Transcription step, and
 * Home's setup checklist — one subscription shape, so a download reads the
 * same everywhere.
 */
export function useSttModels() {
  const load = useSettingsStore((s) => s.load);
  const [statuses, setStatuses] = useState<SttModelStatus[]>([]);
  const [live, setLive] = useState<Record<string, SttDownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.stt.listModels();
      setStatuses(list);
      setLive((l) => {
        const next = { ...l };
        for (const s of list) if (s.download && !TERMINAL.has(s.download.state)) next[s.modelId] = s.download;
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.events.onSttDownloadProgress((p) => {
      setLive((l) => {
        if (TERMINAL.has(p.state)) {
          const { [p.modelId]: _gone, ...rest } = l;
          return rest;
        }
        return { ...l, [p.modelId]: p };
      });
      if (TERMINAL.has(p.state)) {
        void refresh();
        void load();
      }
    });
  }, [refresh, load]);

  const installed = new Set(statuses.filter((s) => s.installed).map((s) => s.modelId));
  return { statuses, live, installed, error, setError, refresh };
}

/**
 * The NVIDIA model rows: download / progress / cancel / Use / delete. Used
 * by the Speech-to-Text panel and by onboarding, which must behave
 * identically — a download started in one continues in the other, and the
 * strip under the title bar shows it everywhere in between.
 *
 * `selectedModelId` is `stt.localModelId`; `onSelect` writes it.
 */
export function LocalModelList({
  selectedModelId,
  onSelect,
  models: external,
}: {
  selectedModelId: string;
  onSelect: (id: string) => void | Promise<void>;
  /** Pass a hook result to share one subscription with a parent; otherwise
   *  the list subscribes itself. */
  models?: ReturnType<typeof useSttModels>;
}) {
  const own = useSttModels();
  const m = external ?? own;
  const load = useSettingsStore((s) => s.load);

  return (
    <>
      {!m.installed.has(selectedModelId) && (
        <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          Download a model to use local transcription. Until one is installed, sessions cannot start
          with the Local engine.
        </p>
      )}
      {m.error && <p className="mb-3 text-xs text-red-300">{m.error}</p>}
      <ul className="divide-y divide-white/5">
        {LOCAL_STT_MODELS.map((model) => (
          <LocalModelRow
            key={model.id}
            model={model}
            installed={m.installed.has(model.id)}
            selected={selectedModelId === model.id}
            progress={m.live[model.id] ?? null}
            onUse={() => void onSelect(model.id)}
            onDownload={() => {
              m.setError(null);
              void api.stt.download(model.id).catch((e: Error) => m.setError(e.message));
            }}
            onCancel={() => void api.stt.cancelDownload(model.id)}
            onDelete={async () => {
              m.setError(null);
              try {
                await api.stt.deleteModel(model.id);
                await m.refresh();
                await load();
              } catch (e) {
                m.setError((e as Error).message);
              }
            }}
          />
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        Each model is about 630 MB and runs on the CPU; the first session after launch takes a
        few seconds to load it. The English model is the stronger choice for English calls —
        pick the multilingual one only when you need another language.
      </p>
    </>
  );
}

export function Dot({ on, tone = 'green' }: { on: boolean; tone?: 'green' | 'neutral' }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
        on ? (tone === 'green' ? 'bg-emerald-400' : 'bg-neutral-300') : 'border border-neutral-600'
      }`}
    />
  );
}

function LocalModelRow({
  model,
  installed,
  selected,
  progress,
  onUse,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: LocalSttModel;
  installed: boolean;
  selected: boolean;
  progress: SttDownloadProgress | null;
  onUse: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  // Deleting 630 MB is cheap to redo but slow to undo — a two-click inline
  // confirm (no native dialog: those leak through Privacy Mode).
  const [confirming, setConfirming] = useState(false);
  const downloading = !!progress;
  return (
    <li className="flex items-center justify-between gap-3 py-3" title={model.description}>
      <span className="flex min-w-0 items-center gap-3">
        <Dot on={installed} tone={selected ? 'green' : 'neutral'} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm text-neutral-100">{model.name}</span>
            <Badge tone={model.languages === 'en' ? 'blue' : 'neutral'}>
              {model.languages === 'en' ? 'English' : '40 languages'}
            </Badge>
            {model.recommended && <Badge tone="green">recommended</Badge>}
          </span>
          <span className="block text-xs text-neutral-500">
            {formatBytes(model.totalBytes)} · partial text every ~{model.chunkMs} ms
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {downloading ? (
          <>
            <span className="tabular-nums text-xs text-neutral-300">
              {progress.state === 'verifying' ? 'Verifying…' : `${Math.round(progress.percent)}%`}
            </span>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : !installed ? (
          <Button variant="primary" onClick={onDownload}>
            Download
          </Button>
        ) : selected ? (
          <Badge tone="green">Active</Badge>
        ) : (
          <Button onClick={onUse}>Use</Button>
        )}
        {installed && !downloading && (
          confirming ? (
            <>
              <Button variant="danger" onClick={() => void onDelete().finally(() => setConfirming(false))}>
                Delete {formatBytes(model.totalBytes)}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <button
              type="button"
              title="Delete the downloaded files"
              onClick={() => setConfirming(true)}
              className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-white/5 hover:text-red-300"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )
        )}
      </span>
    </li>
  );
}
