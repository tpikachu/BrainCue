import { describe, expect, it } from 'vitest';
import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import type { Readiness } from '@shared/types';
import { LOCAL_STT_MODELS } from '@shared/stt';
import { activeDownload, aiRow, setupComplete, setupRows, transcriptionRow, type SetupInputs } from './setupChecklistState';

const EN = LOCAL_STT_MODELS[0];

const status = (over: Partial<SttModelStatus> = {}): SttModelStatus => ({
  modelId: EN.id,
  installed: false,
  bytesOnDisk: 0,
  download: null,
  ...over,
});

const progress = (over: Partial<SttDownloadProgress> = {}): SttDownloadProgress => ({
  modelId: EN.id,
  state: 'downloading',
  receivedBytes: 1,
  totalBytes: EN.totalBytes,
  percent: 42,
  ...over,
});

/** Main's readiness (services/readiness.ts), as the renderer receives it. */
const readiness = (o: { chat?: boolean; stt?: boolean; engine?: 'cloud' | 'local'; provider?: string } = {}): Readiness => ({
  chat: {
    ready: o.chat ?? false,
    provider: (o.provider ?? 'anthropic') as Readiness['chat']['provider'],
    model: 'claude-sonnet-5-5',
    classifyModel: 'claude-haiku-5-5',
    explanation: 'Anthropic · Claude Sonnet 5.5 — Balanced picks fast first token with stronger answers.',
    ...(o.chat ? {} : { problem: 'No AI provider is set up — nothing can detect questions or write answers.' }),
  },
  transcription: { ready: o.stt ?? false, engine: o.engine ?? 'cloud' },
  retrieval: { ready: true, mode: 'lexical' },
  features: {
    parsing: { ready: true },
    mock: { ready: false },
    sparring: { ready: false },
    tailoring: { ready: false },
  },
});

const inputs = (over: Partial<SetupInputs> = {}): SetupInputs => ({
  stt: { engine: 'cloud', localModelId: EN.id },
  readiness: readiness(),
  models: [],
  live: {},
  ...over,
});

describe('setupComplete — the whole gate, from main readiness', () => {
  it('needs an AI provider AND transcription — whichever provider, whichever engine', () => {
    expect(setupComplete(readiness({ chat: true, stt: true }))).toBe(true);
    // Anthropic + on-device transcription, no OpenAI key at all: complete.
    expect(setupComplete(readiness({ chat: true, stt: true, engine: 'local', provider: 'anthropic' }))).toBe(true);
    expect(setupComplete(readiness({ chat: false, stt: true }))).toBe(false);
    expect(setupComplete(readiness({ chat: true, stt: false }))).toBe(false);
  });
  it('unknown (still loading) is never "complete"', () => {
    expect(setupComplete(null)).toBe(false);
  });
});

describe('the Transcription row', () => {
  it('cloud: ready when main says so; missing names the OpenAI key AND the keyless alternative', () => {
    const ready = transcriptionRow(inputs({ readiness: readiness({ stt: true }) }));
    expect(ready.status).toBe('ready');
    expect(ready.detail).toMatch(/Cloud/);
    const missing = transcriptionRow(inputs());
    expect(missing.status).toBe('missing');
    expect(missing.detail).toMatch(/OpenAI key/);
    expect(missing.detail).toMatch(/on-device/);
    expect(missing.route).toBe('/settings/speech');
    expect(transcriptionRow(inputs({ readiness: null })).status).toBe('pending');
  });

  it('local: names the model and reports the download as a percentage', () => {
    const local = { engine: 'local' as const, localModelId: EN.id };
    const downloading = transcriptionRow(inputs({ stt: local, live: { [EN.id]: progress() } }));
    expect(downloading.status).toBe('pending');
    expect(downloading.detail).toBe(`Local — ${EN.name}, downloading 42%`);

    const verifying = transcriptionRow(inputs({ stt: local, live: { [EN.id]: progress({ state: 'verifying' }) } }));
    expect(verifying.detail).toMatch(/verifying/);

    const none = transcriptionRow(inputs({ stt: local }));
    expect(none.status).toBe('missing');
    expect(none.action).toBe('Download');

    const installed = transcriptionRow(
      inputs({ stt: local, models: [status({ installed: true })], readiness: readiness({ stt: true, engine: 'local' }) }),
    );
    expect(installed.status).toBe('ready');
    expect(installed.detail).toBe(`Local — ${EN.name}`);
  });

  it('a finished or cancelled event no longer counts as a download', () => {
    const i = inputs({ live: { [EN.id]: progress({ state: 'done' }) }, models: [status()] });
    expect(activeDownload(i, EN.id)).toBeNull();
    // …but a download that began before this mounted (only the list knows) does.
    expect(activeDownload(inputs({ models: [status({ download: progress() })] }), EN.id)?.percent).toBe(42);
  });
});

describe('the AI row — any provider with a key', () => {
  it('ready names the provider and model; no OpenAI key is required', () => {
    const r = aiRow(readiness({ chat: true, provider: 'anthropic' }));
    expect(r.status).toBe('ready');
    expect(r.detail).toBe('Anthropic · Claude Sonnet 5.5');
    expect(r.detail).not.toMatch(/OpenAI/);
  });
  it("missing says main's concrete problem and links to the fix", () => {
    const r = aiRow(readiness({ chat: false }));
    expect(r.status).toBe('missing');
    expect(r.detail).toMatch(/No AI provider is set up/);
    expect(r.route).toBe('/settings/models');
    expect(r.action).toBe('Add key');
  });
  it('still loading is "checking", not missing', () => {
    expect(aiRow(null)).toMatchObject({ status: 'pending', detail: 'checking…' });
  });
});

describe('setupRows', () => {
  it('is always the two rows, transcription first', () => {
    expect(setupRows(inputs()).map((r) => r.id)).toEqual(['transcription', 'ai']);
  });
});
