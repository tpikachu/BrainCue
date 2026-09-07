import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_STT_MODELS } from '@shared/stt';

// The store derives its root from electron's userData — point it at a temp dir.
const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
// Keep the network out: the download is a controllable stand-in.
const dl = vi.hoisted(() => ({
  resolve: null as null | ((p: unknown) => void),
  calls: 0,
}));
vi.mock('./downloader', () => ({
  downloadModel: vi.fn((model: { id: string }, opts: { signal: AbortSignal }) => {
    dl.calls++;
    return new Promise((resolve) => {
      dl.resolve = resolve;
      opts.signal.addEventListener('abort', () =>
        resolve({ modelId: model.id, state: 'cancelled', receivedBytes: 0, totalBytes: 0, percent: 0 }),
      );
    });
  }),
}));

import {
  activeDownload,
  bytesOnDisk,
  cancelDownload,
  installed,
  listModelStatuses,
  modelDir,
  remove,
  startDownload,
} from './modelStore';

const model = LOCAL_STT_MODELS[0];

const writeSized = (file: string, size: number): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(size));
};

beforeEach(() => {
  state.userData = mkdtempSync(path.join(tmpdir(), 'braincue-userdata-'));
  dl.calls = 0;
  dl.resolve = null;
});
afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true });
});

describe('installed()', () => {
  it('is false for an unknown id and for a model with nothing on disk', () => {
    expect(installed('nope')).toBe(false);
    expect(installed(model.id)).toBe(false);
  });

  it('is false when any file is missing or has the wrong size', () => {
    const dir = modelDir(model.id);
    for (const f of model.files.slice(0, -1)) writeSized(path.join(dir, f.name), f.bytes);
    expect(installed(model.id)).toBe(false); // last file missing
    const last = model.files.at(-1)!;
    writeSized(path.join(dir, last.name), last.bytes - 1);
    expect(installed(model.id)).toBe(false); // one byte short
    writeSized(path.join(dir, last.name), last.bytes + 1);
    expect(installed(model.id)).toBe(false); // one byte over
  });

  it('is true only when every catalog file is present at exactly its pinned size', () => {
    const dir = modelDir(model.id);
    for (const f of model.files) writeSized(path.join(dir, f.name), f.bytes);
    expect(installed(model.id)).toBe(true);
    // a stray .part does not change that
    writeSized(path.join(dir, 'encoder.int8.onnx.part'), 10);
    expect(installed(model.id)).toBe(true);
  });

  it('models live under <userData>/models/stt/<id>', () => {
    expect(modelDir(model.id)).toBe(path.join(state.userData, 'models', 'stt', model.id));
  });
});

describe('bytesOnDisk()', () => {
  it('sums complete files and .part remnants', () => {
    const dir = modelDir(model.id);
    writeSized(path.join(dir, 'tokens.txt'), model.files[3].bytes);
    writeSized(path.join(dir, 'encoder.int8.onnx.part'), 1234);
    expect(bytesOnDisk(model.id)).toBe(model.files[3].bytes + 1234);
    expect(bytesOnDisk('nope')).toBe(0);
  });
});

describe('downloads + remove()', () => {
  it('listModelStatuses reports every catalog model with install state and no download', () => {
    const list = listModelStatuses();
    expect(list.map((s) => s.modelId)).toEqual(LOCAL_STT_MODELS.map((m) => m.id));
    expect(list.every((s) => !s.installed && s.download === null)).toBe(true);
  });

  it('one download per model: the second start is a no-op; cancel aborts it', async () => {
    const seen: string[] = [];
    expect(startDownload(model.id, (p) => seen.push(p.state))).toEqual({ started: true });
    expect(startDownload(model.id, () => undefined)).toEqual({ started: true });
    expect(dl.calls).toBe(1);
    expect(activeDownload(model.id)?.state).toBe('downloading');
    expect(listModelStatuses()[0].download?.modelId).toBe(model.id);

    expect(cancelDownload(model.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(activeDownload(model.id)).toBeNull();
    expect(cancelDownload(model.id)).toBe(false);
  });

  it('refuses to start an unknown model', () => {
    expect(() => startDownload('nope', () => undefined)).toThrow(/unknown/i);
  });

  it('remove() refuses while a download is active, then deletes the directory', async () => {
    const dir = modelDir(model.id);
    writeSized(path.join(dir, 'encoder.int8.onnx.part'), 5);
    startDownload(model.id, () => undefined);
    expect(() => remove(model.id)).toThrow(/cancel/i);
    cancelDownload(model.id);
    await new Promise((r) => setTimeout(r, 0));
    remove(model.id);
    expect(existsSync(dir)).toBe(false);
    expect(() => remove('nope')).toThrow(/unknown/i);
  });
});
