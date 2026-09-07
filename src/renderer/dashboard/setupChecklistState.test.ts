import { describe, expect, it } from 'vitest';
import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
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

const inputs = (over: Partial<SetupInputs> = {}): SetupInputs => ({
  stt: { engine: 'cloud', localModelId: EN.id },
  sttReady: false,
  apiKeyPresent: false,
  providerKeys: { openai: false, anthropic: false, google: false, groq: false, openrouter: false },
  models: [],
  live: {},
  ...over,
});

describe('setupComplete — the whole gate', () => {
  it('needs transcription AND the OpenAI key', () => {
    expect(setupComplete({ sttReady: true, apiKeyPresent: true })).toBe(true);
    expect(setupComplete({ sttReady: false, apiKeyPresent: true })).toBe(false);
    expect(setupComplete({ sttReady: true, apiKeyPresent: false })).toBe(false);
  });
});

describe('the Transcription row', () => {
  it('cloud: ready with the key, missing without', () => {
    const ready = transcriptionRow(inputs({ apiKeyPresent: true, sttReady: true }));
    expect(ready.status).toBe('ready');
    expect(ready.detail).toMatch(/Cloud/);
    const missing = transcriptionRow(inputs());
    expect(missing.status).toBe('missing');
    expect(missing.detail).toMatch(/OpenAI key/);
    expect(missing.route).toBe('/settings/speech');
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

    const installed = transcriptionRow(inputs({ stt: local, models: [status({ installed: true })], sttReady: true }));
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

describe('the AI row', () => {
  it('says the OpenAI key is the required one, and lists extras', () => {
    const none = aiRow(inputs());
    expect(none.status).toBe('missing');
    expect(none.detail).toBe('OpenAI key missing');
    expect(none.route).toBe('/settings/models');

    const both = aiRow(
      inputs({
        apiKeyPresent: true,
        providerKeys: { openai: true, anthropic: true, google: false, groq: false, openrouter: false },
      }),
    );
    expect(both.status).toBe('ready');
    expect(both.detail).toBe('OpenAI key ✓, Anthropic ✓');

    // An extra alone does not make AI ready — retrieval and the defaults run on OpenAI.
    const extraOnly = aiRow(
      inputs({ providerKeys: { openai: false, anthropic: true, google: false, groq: false, openrouter: false } }),
    );
    expect(extraOnly.status).toBe('missing');
    expect(extraOnly.detail).toBe('OpenAI key missing, Anthropic ✓');
  });
});

describe('setupRows', () => {
  it('is always the two rows, transcription first', () => {
    expect(setupRows(inputs()).map((r) => r.id)).toEqual(['transcription', 'ai']);
  });
});
