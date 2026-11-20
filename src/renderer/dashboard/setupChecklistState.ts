import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import type { Readiness } from '@shared/types';
import { localSttModel, type SttPrefs } from '@shared/stt';
import { settingsPath } from './pages/settings/sections';

/**
 * "Is BrainCue set up?" — one answer, shared by Home's Finish-setup card and
 * the onboarding summary, so the two never disagree about what is missing.
 *
 * Two rows because a live interview needs exactly two things beyond a
 * profile: a way to hear and an AI to think with. Both come from main's
 * per-capability readiness (services/readiness.ts), never from "is there an
 * OpenAI key?": ANY provider with a key works for answers, and the on-device
 * transcriber needs no key at all. Only cloud transcription needs OpenAI, and
 * its row says so. Each row says what IS configured, not just that something
 * is wrong — "Local — model downloading 42%" is a state you can wait on.
 */

export type SetupStatus = 'ready' | 'pending' | 'missing';

export interface SetupRow {
  id: 'transcription' | 'ai';
  label: string;
  status: SetupStatus;
  /** One line: the engine or provider, and what is still needed. */
  detail: string;
  /** Where the fix lives. */
  route: string;
  /** The button's label. */
  action: string;
}

export interface SetupInputs {
  stt: SttPrefs;
  /** Main's readiness; null while it is being read. */
  readiness: Readiness | null;
  /** From `stt:list-models`, when known. */
  models: SttModelStatus[];
  /** Live progress events, keyed by model id — the strip's source of truth
   *  while a download is in flight. */
  live: Record<string, SttDownloadProgress>;
}

/** The whole gate: can an interview's capabilities run? Unknown is not ready. */
export function setupComplete(readiness: Readiness | null): boolean {
  return !!readiness && readiness.chat.ready && readiness.transcription.ready;
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
  const ready = !!i.readiness?.transcription.ready;
  if (i.stt.engine === 'cloud') {
    if (ready) return { id: 'transcription', label: 'Transcription', status: 'ready', detail: 'Cloud — OpenAI Realtime', route, action: 'Change' };
    if (!i.readiness) return { id: 'transcription', label: 'Transcription', status: 'pending', detail: 'Cloud — checking…', route, action: 'View' };
    return {
      id: 'transcription',
      label: 'Transcription',
      status: 'missing',
      // The one capability that genuinely needs OpenAI — said, with the
      // keyless alternative.
      detail: 'Cloud — needs an OpenAI key (or switch to on-device)',
      route,
      action: 'Set up',
    };
  }
  const model = localSttModel(i.stt.localModelId);
  const name = model?.name ?? i.stt.localModelId;
  const installed = i.models.some((m) => m.modelId === i.stt.localModelId && m.installed) || ready;
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

/** "Anthropic · Claude Sonnet 5.5" — the provider and model, without the why. */
export const chatLabel = (r: Readiness): string => r.chat.explanation.split(' — ')[0] || r.chat.provider;

export function aiRow(readiness: Readiness | null): SetupRow {
  const route = settingsPath('models');
  if (!readiness) return { id: 'ai', label: 'AI', status: 'pending', detail: 'checking…', route, action: 'View' };
  if (readiness.chat.ready) return { id: 'ai', label: 'AI', status: 'ready', detail: chatLabel(readiness), route, action: 'Change' };
  return {
    id: 'ai',
    label: 'AI',
    status: 'missing',
    detail: readiness.chat.problem ?? 'No AI provider is set up',
    route,
    action: 'Add key',
  };
}

export function setupRows(i: SetupInputs): SetupRow[] {
  return [transcriptionRow(i), aiRow(i.readiness)];
}
