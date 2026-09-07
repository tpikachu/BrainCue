import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { SttDownloadProgress } from '@shared/ipc';
import type { LocalSttModel } from '@shared/stt';

/**
 * Resumable model download (docs/22-LOCAL-STT.md §download).
 *
 * Every catalog file streams to `<name>.part`; a `.part` left by a cancelled
 * or crashed run is resumed with `Range: bytes=<size>-` (a 200 instead of a
 * 206 means the server ignored the range → the file restarts). A finished
 * `.part` is renamed only when its size is EXACTLY the pinned catalog size —
 * that equality is the whole install check, so a truncated or wrong file can
 * never pass as installed. No electron import: the store passes the directory
 * in, so this runs against a local http fixture in downloader.test.ts.
 */

export interface DownloadOptions {
  /** Model directory (created if missing). */
  dir: string;
  signal: AbortSignal;
  onProgress: (p: SttDownloadProgress) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Minimum gap between `downloading` ticks (default 250 ms). */
  throttleMs?: number;
  /** Back-off before each retry of a failed transfer (default 3 retries). */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 4000];

/** A definitive failure — retrying would download the same wrong bytes. */
class SizeMismatchError extends Error {
  constructor() {
    super('A downloaded file did not match its expected size. Please try again.');
  }
}

class HttpError extends Error {
  constructor(status: number) {
    super(`The download server responded with HTTP ${status}.`);
  }
}

const GENERIC_ERROR = 'Download failed after several attempts. Check your connection and try again.';

const abortError = (): Error => new DOMException('Download cancelled', 'AbortError');

const isAbort = (e: unknown, signal: AbortSignal): boolean =>
  signal.aborted || (e instanceof Error && e.name === 'AbortError');

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `bytes 100-999/1000` → 1000; `*` or absent → null. */
export function contentRangeTotal(header: string | null): number | null {
  const m = header?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** Downloads every file of `model` into `opts.dir`. Resolves with the terminal
 *  progress (`done` | `error` | `cancelled`) — it never rejects. */
export async function downloadModel(
  model: LocalSttModel,
  opts: DownloadOptions,
): Promise<SttDownloadProgress> {
  const { dir, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const throttleMs = opts.throttleMs ?? 250;
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let completedBytes = 0; // files fully on disk
  let currentBytes = 0; // the in-flight file, resumed bytes included
  let currentFile: string | undefined;
  let lastEmit = 0;

  const emit = (state: SttDownloadProgress['state'], error?: string): SttDownloadProgress => {
    const receivedBytes = state === 'done' ? model.totalBytes : completedBytes + currentBytes;
    const p: SttDownloadProgress = {
      modelId: model.id,
      state,
      receivedBytes,
      totalBytes: model.totalBytes,
      percent:
        model.totalBytes > 0 ? Math.min(100, Math.floor((receivedBytes / model.totalBytes) * 100)) : 0,
      file: state === 'done' ? undefined : currentFile,
    };
    if (error) p.error = error;
    lastEmit = Date.now();
    opts.onProgress(p);
    return p;
  };
  const tick = (): void => {
    if (Date.now() - lastEmit >= throttleMs) emit('downloading');
  };

  /** One transfer attempt: resume or restart the `.part`, stream to disk. */
  const transferOnce = async (
    file: LocalSttModel['files'][number],
    partPath: string,
  ): Promise<void> => {
    let existing = await sizeOf(partPath);
    if (existing > file.bytes) {
      await rm(partPath, { force: true });
      existing = 0;
    }
    currentBytes = existing;
    if (existing === file.bytes) return; // fully present, only the verify/rename remains

    const headers: Record<string, string> = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    const res = await fetchImpl(file.url, { headers, signal, redirect: 'follow' });

    let append = false;
    if (res.status === 206 && existing > 0) {
      const total = contentRangeTotal(res.headers.get('content-range'));
      if (total !== null && total !== file.bytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new SizeMismatchError();
      }
      append = true;
    } else if (res.status === 200) {
      const len = res.headers.get('content-length');
      if (len !== null && Number(len) !== file.bytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new SizeMismatchError();
      }
      currentBytes = 0; // the server ignored the range (or there was none): restart the file
    } else {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 416) {
        // Range not satisfiable: our .part disagrees with the server — start over.
        await rm(partPath, { force: true });
        currentBytes = 0;
      }
      throw new HttpError(res.status);
    }
    if (!res.body) throw new Error('empty response body');

    emit('downloading');
    const out = createWriteStream(partPath, { flags: append ? 'a' : 'w' });
    const write = (chunk: Uint8Array): Promise<void> =>
      new Promise((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())));
    try {
      // Explicit loop rather than stream.pipeline: pipeline() destroys the file
      // stream on a body error and drops whatever was still queued behind the
      // async open, leaving an empty .part after an early connection loss.
      // Awaiting each write flushes it to the fd, so the bytes received before
      // the error (or the cancel) are on disk for the resume.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        currentBytes += chunk.byteLength;
        tick();
        await write(chunk);
      }
    } finally {
      out.end();
      await finished(out).catch(() => undefined);
    }
  };

  const transferWithRetries = async (
    file: LocalSttModel['files'][number],
    partPath: string,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      try {
        await transferOnce(file, partPath);
        return;
      } catch (e) {
        if (isAbort(e, signal) || e instanceof SizeMismatchError) throw e;
        if (attempt >= retryDelays.length) throw e;
        await sleep(retryDelays[attempt], signal);
      }
    }
  };

  try {
    await mkdir(dir, { recursive: true });
    for (const file of model.files) {
      if (signal.aborted) throw abortError();
      currentFile = file.name;
      currentBytes = 0;
      const finalPath = path.join(dir, file.name);
      const partPath = `${finalPath}.part`;

      const have = await sizeOf(finalPath);
      if (have === file.bytes) {
        completedBytes += file.bytes;
        continue;
      }
      await rm(finalPath, { force: true }); // wrong size (or empty) — redo it

      await transferWithRetries(file, partPath);

      emit('verifying');
      const size = await sizeOf(partPath);
      if (size !== file.bytes) {
        await rm(partPath, { force: true });
        throw new SizeMismatchError();
      }
      await rename(partPath, finalPath);
      completedBytes += file.bytes;
      currentBytes = 0;
    }
    currentFile = undefined;
    return emit('done');
  } catch (e) {
    if (isAbort(e, signal)) return emit('cancelled');
    const message =
      e instanceof SizeMismatchError || e instanceof HttpError ? e.message : GENERIC_ERROR;
    return emit('error', message);
  }
}
