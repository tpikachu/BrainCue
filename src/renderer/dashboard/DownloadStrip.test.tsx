import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import { LOCAL_STT_MODELS } from '@shared/stt';

// The strip talks to the preload bridge; there is no window here. The mock is
// what a real progress event would drive — DownloadStrip.tsx is only wiring.
vi.mock('../lib/api', () => ({
  api: {
    stt: {
      listModels: vi.fn(async () => [] as SttModelStatus[]),
      cancelDownload: vi.fn(async () => ({ cancelled: true })),
      download: vi.fn(async () => ({ started: true as const })),
    },
    events: { onSttDownloadProgress: vi.fn(() => () => {}) },
  },
}));

import { DownloadStripView } from './DownloadStrip';
import {
  DONE_LINGER_MS,
  applyProgress,
  nextExpiry,
  seedFromStatuses,
  visibleEntries,
  type StripState,
} from './downloadStripState';

const EN = LOCAL_STT_MODELS[0];
const ML = LOCAL_STT_MODELS[1];

const progress = (over: Partial<SttDownloadProgress> = {}): SttDownloadProgress => ({
  modelId: EN.id,
  state: 'downloading',
  receivedBytes: 200_000_000,
  totalBytes: EN.totalBytes,
  percent: 30,
  file: 'encoder.int8.onnx',
  ...over,
});

const noop = () => {};
const render = (state: StripState, now = 0) =>
  renderToStaticMarkup(
    <DownloadStripView entries={visibleEntries(state, now)} onCancel={noop} onRetry={noop} onDismiss={noop} />,
  );

describe('the download strip', () => {
  it('renders a fake progress event: model name, file, percent, bytes, Cancel', () => {
    const state = applyProgress({}, progress(), 1000);
    const html = render(state, 1000);
    expect(html).toContain(EN.name);
    expect(html).toContain('encoder.int8.onnx');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('width:30%');
    expect(html).toContain('200 MB / 662 MB');
    expect(html).toContain('Cancel');
  });

  it('is empty when nothing is downloading, and after a cancel', () => {
    expect(visibleEntries({}, 0)).toEqual([]);
    const running = applyProgress({}, progress(), 0);
    expect(visibleEntries(applyProgress(running, progress({ state: 'cancelled' }), 1), 1)).toEqual([]);
  });

  it('shows "Model ready" on done and drops it after the linger', () => {
    const state = applyProgress({}, progress({ state: 'done', percent: 100, receivedBytes: EN.totalBytes }), 5000);
    expect(render(state, 5000)).toContain('Model ready');
    expect(nextExpiry(state, 5000)).toBe(DONE_LINGER_MS);
    expect(visibleEntries(state, 5000 + DONE_LINGER_MS - 1)).toHaveLength(1);
    expect(visibleEntries(state, 5000 + DONE_LINGER_MS)).toEqual([]);
  });

  it('keeps an error row with its message and a Retry until dismissed', () => {
    const state = applyProgress({}, progress({ state: 'error', error: 'ECONNRESET' }), 0);
    const html = render(state, 60 * 60 * 1000); // an hour later, still there
    expect(html).toContain('Download failed');
    expect(html).toContain('ECONNRESET');
    expect(html).toContain('Retry');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('seeds from stt:list-models so an in-flight download shows on mount', () => {
    const statuses: SttModelStatus[] = [
      { modelId: EN.id, installed: false, bytesOnDisk: 1, download: progress({ percent: 12 }) },
      { modelId: ML.id, installed: true, bytesOnDisk: ML.totalBytes, download: null },
    ];
    const state = seedFromStatuses(statuses);
    expect(Object.keys(state)).toEqual([EN.id]);
    expect(render(state)).toContain('aria-valuenow="12"');
  });

  it('orders concurrent downloads by catalog position', () => {
    let state = applyProgress({}, progress({ modelId: ML.id, totalBytes: ML.totalBytes }), 0);
    state = applyProgress(state, progress(), 1);
    expect(visibleEntries(state, 1).map((e) => e.progress.modelId)).toEqual([EN.id, ML.id]);
  });

  it('marks verifying as a full, pulsing bar', () => {
    const html = render(applyProgress({}, progress({ state: 'verifying', percent: 100 }), 0));
    expect(html).toContain('Verifying');
    expect(html).toContain('aria-valuenow="100"');
  });
});
