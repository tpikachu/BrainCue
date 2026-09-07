import { useEffect, useState } from 'react';
import type { SttDownloadProgress } from '@shared/ipc';
import { formatBytes, localSttModel } from '@shared/stt';
import { api } from '../lib/api';
import { CloseIcon } from '../components/icons';
import {
  applyProgress,
  dismiss,
  nextExpiry,
  pruneExpired,
  seedFromStatuses,
  visibleEntries,
  type StripEntry,
  type StripState,
} from './downloadStripState';

/**
 * Slim strip under the title bar (next to UpdateBanner) showing a local STT
 * model download. A 630 MB pull outlives any one page, so it lives in the
 * shell: started from Settings → Speech-to-Text, still visible from Library,
 * survives navigation, and is seeded from `stt:list-models` on mount so a
 * download that began before this window rendered shows up too.
 *
 * Silent when nothing is downloading. `done` lingers ~4 s as "Model ready";
 * `error` stays, with Retry, until dismissed.
 */
export function DownloadStrip() {
  const [state, setState] = useState<StripState>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void api.stt
      .listModels()
      .then((list) => setState((s) => ({ ...seedFromStatuses(list), ...s })))
      .catch(() => {});
    return api.events.onSttDownloadProgress((p) => {
      const t = Date.now();
      setNow(t);
      setState((s) => applyProgress(s, p, t));
    });
  }, []);

  // Tick once when the soonest "Model ready" row is due to disappear.
  useEffect(() => {
    const wait = nextExpiry(state, now);
    if (wait === null) return;
    const id = window.setTimeout(() => {
      const t = Date.now();
      setNow(t);
      setState((s) => pruneExpired(s, t));
    }, wait + 20);
    return () => window.clearTimeout(id);
  }, [state, now]);

  const rows = visibleEntries(state, now);
  if (rows.length === 0) return null;
  return (
    <DownloadStripView
      entries={rows}
      onCancel={(id) => void api.stt.cancelDownload(id)}
      onRetry={(id) => {
        setState((s) => dismiss(s, id));
        void api.stt.download(id).catch(() => {});
      }}
      onDismiss={(id) => setState((s) => dismiss(s, id))}
    />
  );
}

/** Presentational half — rendered by the strip and by its test. */
export function DownloadStripView({
  entries,
  onCancel,
  onRetry,
  onDismiss,
}: {
  entries: StripEntry[];
  onCancel: (modelId: string) => void;
  onRetry: (modelId: string) => void;
  onDismiss: (modelId: string) => void;
}) {
  return (
    <div className="shrink-0 divide-y divide-white/5">
      {entries.map((e) => (
        <DownloadRow key={e.progress.modelId} p={e.progress} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function DownloadRow({
  p,
  onCancel,
  onRetry,
  onDismiss,
}: {
  p: SttDownloadProgress;
  onCancel: (modelId: string) => void;
  onRetry: (modelId: string) => void;
  onDismiss: (modelId: string) => void;
}) {
  const name = localSttModel(p.modelId)?.name ?? p.modelId;

  if (p.state === 'done') {
    return (
      <div
        role="status"
        className="flex h-8 items-center gap-3 bg-emerald-600/90 px-4 text-xs text-white"
      >
        <span className="font-medium">Model ready</span>
        <span className="truncate opacity-80">{name} — local transcription can start.</span>
      </div>
    );
  }

  if (p.state === 'error') {
    return (
      <div role="alert" className="flex h-8 items-center gap-3 bg-red-900/70 px-4 text-xs text-red-100">
        <span className="font-medium">Download failed</span>
        <span className="min-w-0 flex-1 truncate opacity-90" title={p.error}>
          {name}
          {p.error ? ` — ${p.error}` : ''}
        </span>
        <button
          type="button"
          onClick={() => onRetry(p.modelId)}
          className="rounded-md bg-white/15 px-2.5 py-0.5 font-medium transition-colors hover:bg-white/25"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => onDismiss(p.modelId)}
          aria-label="Dismiss"
          className="rounded-md p-0.5 opacity-70 transition-colors hover:bg-white/15 hover:opacity-100"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const verifying = p.state === 'verifying';
  const pct = verifying ? 100 : Math.max(0, Math.min(100, Math.round(p.percent)));
  return (
    <div className="flex h-9 items-center gap-3 bg-neutral-800 px-4 text-xs text-neutral-200">
      <span className="shrink-0 font-medium">{verifying ? 'Verifying' : 'Downloading'}</span>
      <span className="min-w-0 truncate text-neutral-400">
        {name}
        {p.file ? <span className="text-neutral-500"> · {p.file}</span> : null}
      </span>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 min-w-[6rem] flex-1 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={`h-full rounded-full bg-indigo-400 transition-[width] duration-300 ${verifying ? 'animate-pulse' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 tabular-nums text-neutral-300">{pct}%</span>
      <span className="hidden shrink-0 tabular-nums text-neutral-500 sm:inline">
        {formatBytes(p.receivedBytes)} / {formatBytes(p.totalBytes)}
      </span>
      <button
        type="button"
        onClick={() => onCancel(p.modelId)}
        className="shrink-0 rounded-md bg-white/10 px-2.5 py-0.5 font-medium text-neutral-200 transition-colors hover:bg-white/20"
      >
        Cancel
      </button>
    </div>
  );
}
