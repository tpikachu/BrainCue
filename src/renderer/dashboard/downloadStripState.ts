import type { SttDownloadProgress, SttModelStatus } from '@shared/ipc';
import { LOCAL_STT_MODELS } from '@shared/stt';

/**
 * State behind the download strip (DownloadStrip.tsx), kept pure so it can be
 * unit-tested with fake progress events and so the component is only wiring.
 *
 * One entry per model download. `done` lingers for {@link DONE_LINGER_MS} so
 * the user sees "Model ready" rather than a strip that blinks out; `error`
 * stays until dismissed or retried; `cancelled` disappears at once.
 */

export const DONE_LINGER_MS = 4000;

export interface StripEntry {
  progress: SttDownloadProgress;
  /** When the `done` event arrived (ms epoch), for the linger timeout. */
  doneAt: number | null;
}

export type StripState = Record<string, StripEntry>;

const ACTIVE = new Set<SttDownloadProgress['state']>(['downloading', 'verifying']);

/** Seed from `stt:list-models` so a download started before this page mounted
 *  (or before the app window was reopened) is visible immediately. */
export function seedFromStatuses(statuses: SttModelStatus[]): StripState {
  const state: StripState = {};
  for (const s of statuses) {
    if (s.download && ACTIVE.has(s.download.state)) {
      state[s.modelId] = { progress: s.download, doneAt: null };
    }
  }
  return state;
}

export function applyProgress(state: StripState, p: SttDownloadProgress, now: number): StripState {
  if (p.state === 'cancelled') {
    const { [p.modelId]: _gone, ...rest } = state;
    return rest;
  }
  return {
    ...state,
    [p.modelId]: { progress: p, doneAt: p.state === 'done' ? now : null },
  };
}

export function dismiss(state: StripState, modelId: string): StripState {
  const { [modelId]: _gone, ...rest } = state;
  return rest;
}

/** Drop `done` entries whose linger has elapsed. */
export function pruneExpired(state: StripState, now: number): StripState {
  let changed = false;
  const next: StripState = {};
  for (const [id, e] of Object.entries(state)) {
    if (e.doneAt !== null && now - e.doneAt >= DONE_LINGER_MS) {
      changed = true;
      continue;
    }
    next[id] = e;
  }
  return changed ? next : state;
}

/** Rows to render, in catalog order so two concurrent downloads never swap. */
export function visibleEntries(state: StripState, now: number): StripEntry[] {
  const order = new Map(LOCAL_STT_MODELS.map((m, i) => [m.id, i]));
  return Object.values(pruneExpired(state, now)).sort(
    (a, b) => (order.get(a.progress.modelId) ?? 99) - (order.get(b.progress.modelId) ?? 99),
  );
}

/** Milliseconds until the next `done` entry should disappear, or null. */
export function nextExpiry(state: StripState, now: number): number | null {
  let soonest: number | null = null;
  for (const e of Object.values(state)) {
    if (e.doneAt === null) continue;
    const left = Math.max(0, e.doneAt + DONE_LINGER_MS - now);
    soonest = soonest === null ? left : Math.min(soonest, left);
  }
  return soonest;
}
