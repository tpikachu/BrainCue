import { app } from 'electron';
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import { LOCAL_STT_MODELS, localSttModel } from '@shared/stt';
import { downloadModel } from './downloader';

/**
 * Where local STT models live and what is on disk (docs/22-LOCAL-STT.md).
 *
 *   <userData>/models/stt/<modelId>/{encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt}
 *
 * "Installed" is a pure disk fact: every catalog file exists at EXACTLY its
 * pinned byte size. No manifest, no hash file — the pinned sizes in
 * shared/stt.ts are the manifest. The in-memory map of active downloads is
 * the only mutable state here; it is what `stt:list-models` embeds and what
 * `remove` refuses to race.
 */

export const modelsRoot = (): string => path.join(app.getPath('userData'), 'models', 'stt');
export const modelDir = (modelId: string): string => path.join(modelsRoot(), modelId);

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function installed(modelId: string): boolean {
  const model = localSttModel(modelId);
  if (!model) return false;
  const dir = modelDir(modelId);
  return model.files.every((f) => sizeOf(path.join(dir, f.name)) === f.bytes);
}

/** Complete files + `.part` remnants, so the UI can say "312 MB of 662 MB" before a resume. */
export function bytesOnDisk(modelId: string): number {
  const model = localSttModel(modelId);
  if (!model) return 0;
  const dir = modelDir(modelId);
  return model.files.reduce(
    (n, f) => n + sizeOf(path.join(dir, f.name)) + sizeOf(path.join(dir, `${f.name}.part`)),
    0,
  );
}

interface ActiveDownload {
  controller: AbortController;
  progress: SttDownloadProgress;
  promise: Promise<SttDownloadProgress>;
}

const active = new Map<string, ActiveDownload>();

export function activeDownload(modelId: string): SttDownloadProgress | null {
  return active.get(modelId)?.progress ?? null;
}

export function modelStatus(modelId: string): SttModelStatus {
  return {
    modelId,
    installed: installed(modelId),
    bytesOnDisk: bytesOnDisk(modelId),
    download: activeDownload(modelId),
  };
}

export function listModelStatuses(): SttModelStatus[] {
  return LOCAL_STT_MODELS.map((m) => modelStatus(m.id));
}

/**
 * Start (or resume) downloading a model. One download per model: a second
 * call while one is running is a no-op. `onProgress` receives every tick
 * including the terminal one; the model leaves the active map right after.
 */
export function startDownload(
  modelId: string,
  onProgress: (p: SttDownloadProgress) => void,
): { started: true } {
  if (active.has(modelId)) return { started: true };
  const model = localSttModel(modelId);
  if (!model) throw new Error('Unknown speech model.');

  const controller = new AbortController();
  const onDisk = bytesOnDisk(modelId);
  const initial: SttDownloadProgress = {
    modelId,
    state: 'downloading',
    receivedBytes: onDisk,
    totalBytes: model.totalBytes,
    percent: model.totalBytes ? Math.min(100, Math.floor((onDisk / model.totalBytes) * 100)) : 0,
  };
  const entry = { controller, progress: initial } as ActiveDownload;
  entry.promise = downloadModel(model, {
    dir: modelDir(modelId),
    signal: controller.signal,
    onProgress: (p) => {
      entry.progress = p;
      onProgress(p);
    },
  }).finally(() => {
    if (active.get(modelId) === entry) active.delete(modelId);
  });
  active.set(modelId, entry);
  return { started: true };
}

/** True when there was a download to cancel. The `.part` files stay for a resume. */
export function cancelDownload(modelId: string): boolean {
  const entry = active.get(modelId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

/** Delete the model directory (complete files and remnants). */
export function remove(modelId: string): void {
  if (active.has(modelId)) throw new Error('Cancel the download before deleting this model.');
  if (!localSttModel(modelId)) throw new Error('Unknown speech model.');
  rmSync(modelDir(modelId), { recursive: true, force: true });
}
