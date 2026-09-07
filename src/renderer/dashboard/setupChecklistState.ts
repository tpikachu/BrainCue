import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import type { CloudProviderId } from '@shared/providers';
import { CLOUD_PROVIDERS } from '@shared/providers';
import { localSttModel, type SttPrefs } from '@shared/stt';
import { settingsPath } from './pages/settings/sections';

/**
 * "Is BrainCue set up?" — one answer, shared by Home's Finish-setup card and
 * the onboarding summary, so the two never disagree about what is missing.
 *
 * Two rows because a live session needs exactly two things beyond a profile:
 * a way to hear (`sttReady`) and the OpenAI key (retrieval, embeddings and
 * the default models run there; other providers are extras). Each row says
 * what IS configured, not just that something is wrong — "Local — model
 * downloading 42%" is a state you can wait on, "not set up" is not.
 */

export type SetupStatus = 'ready' | 'pending' | 'missing';

export interface SetupRow {
  id: 'transcription' | 'ai';
  label: string;
  status: SetupStatus;
  /** One line: the engine or providers, and what is still needed. */
  detail: string;
  /** Where the fix lives. */
  route: string;
  /** The button's label. */
  action: string;
}

export interface SetupInputs {
  stt: SttPrefs;
  sttReady: boolean;
  apiKeyPresent: boolean;
  providerKeys: Partial<Record<CloudProviderId, boolean>> | undefined;
  /** From `stt:list-models`, when known. */
  models: SttModelStatus[];
  /** Live progress events, keyed by model id — the strip's source of truth
   *  while a download is in flight. */
  live: Record<string, SttDownloadProgress>;
}

/** The whole gate, as the shell and Start read it. */
export function setupComplete(s: { sttReady: boolean; apiKeyPresent: boolean }): boolean {
  return s.sttReady && s.apiKeyPresent;
}

const TERMINAL = new Set<SttDownloadProgress['state']>(['done', 'error', 'cancelled']);

/** The download in flight for a model, from live events first (fresh) and
 *  the model list second (what was already running when this mounted). */
export function activeDownload(i: Pick<SetupInputs, 'models' | 'live'>, modelId: string): SttDownloadProgress | null {
  const l = i.live[modelId];
  if (l && !TERMINAL.has(l.state)) return l;
  const s = i.models.find((m) => m.modelId === modelId)?.download ?? null;
  return s && !TERMINAL.has(s.state) ? s : null;
}

export function transcriptionRow(i: SetupInputs): SetupRow {
  const route = settingsPath('speech');
  if (i.stt.engine === 'cloud') {
    return i.apiKeyPresent
      ? { id: 'transcription', label: 'Transcription', status: 'ready', detail: 'Cloud — OpenAI Realtime', route, action: 'Change' }
      : {
          id: 'transcription',
          label: 'Transcription',
          status: 'missing',
          detail: 'Cloud — needs the OpenAI key',
          route,
          action: 'Set up',
        };
  }
  const model = localSttModel(i.stt.localModelId);
  const name = model?.name ?? i.stt.localModelId;
  const installed = i.models.some((m) => m.modelId === i.stt.localModelId && m.installed) || i.sttReady;
  if (installed) {
    return { id: 'transcription', label: 'Transcription', status: 'ready', detail: `Local — ${name}`, route, action: 'Change' };
  }
  const dl = activeDownload(i, i.stt.localModelId);
  if (dl) {
    const progress = dl.state === 'verifying' ? 'verifying' : `downloading ${Math.round(dl.percent)}%`;
    return {
      id: 'transcription',
      label: 'Transcription',
      status: 'pending',
      detail: `Local — ${name}, ${progress}`,
      route,
      action: 'View',
    };
  }
  return {
    id: 'transcription',
    label: 'Transcription',
    status: 'missing',
    detail: `Local — ${name} is not downloaded`,
    route,
    action: 'Download',
  };
}

export function aiRow(i: Pick<SetupInputs, 'apiKeyPresent' | 'providerKeys'>): SetupRow {
  const route = settingsPath('models');
  const extras = CLOUD_PROVIDERS.filter((p) => p.id !== 'openai' && i.providerKeys?.[p.id]).map((p) => p.name);
  const extrasText = extras.length ? `, ${extras.map((n) => `${n} ✓`).join(', ')}` : '';
  if (i.apiKeyPresent) {
    return { id: 'ai', label: 'AI', status: 'ready', detail: `OpenAI key ✓${extrasText}`, route, action: 'Change' };
  }
  return {
    id: 'ai',
    label: 'AI',
    status: 'missing',
    detail: `OpenAI key missing${extrasText}`,
    route,
    action: 'Add key',
  };
}

export function setupRows(i: SetupInputs): SetupRow[] {
  return [transcriptionRow(i), aiRow(i)];
}
