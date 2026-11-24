import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';
import type { Readiness } from '@shared/types';
import type { SttDownloadProgress } from '@shared/ipc';
import { useSettingsStore } from './useSettingsStore';

/**
 * Main's per-capability readiness (services/readiness.ts) — the ONE answer to
 * "can an interview start?", read by first-run setup, Home's setup card and
 * every Start gate. It replaced the renderer's own "is there an OpenAI key?"
 * checks, which told a user with an Anthropic key and the on-device
 * transcriber that setup was unfinished.
 *
 * `null` until the first read: callers must treat that as "checking", never
 * as ready or as missing.
 */
interface ReadinessState {
  readiness: Readiness | null;
  refresh: () => Promise<void>;
}

export const useReadinessStore = create<ReadinessState>((set) => ({
  readiness: null,
  refresh: async () => {
    try {
      set({ readiness: await api.settings.readiness() });
    } catch {
      /* keep the last answer; the next settings change asks again */
    }
  },
}));

export const useReadiness = (): Readiness | null => useReadinessStore((s) => s.readiness);

/** A finished model download changes what can run, but is not a settings
 *  write — so settings (and with them readiness) are re-read when one ends. */
export const downloadSettled = (p: Pick<SttDownloadProgress, 'state'>): boolean => p.state === 'done';

/**
 * Keeps readiness current. Mounted ONCE, by the dashboard shell: every
 * configuration change in this app reloads the settings store (key saved,
 * preset or override changed, engine switched), so a new settings object is
 * the signal to ask main again.
 */
export function useReadinessSync(): void {
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const refresh = useReadinessStore((s) => s.refresh);
  useEffect(() => {
    if (settings) void refresh();
  }, [settings, refresh]);
  useEffect(
    () =>
      api.events.onSttDownloadProgress((p) => {
        if (downloadSettled(p)) void load();
      }),
    [load],
  );
}
