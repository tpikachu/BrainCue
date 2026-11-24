import { create } from 'zustand';
import { api } from '../lib/api';
import type { AppSettings } from '@shared/types';
import { createSettingsFeed } from '../lib/settingsFeed';

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  /** Main's push (`settings:changed`) — always the newest state. */
  receive: (settings: AppSettings) => void;
  load: () => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  testApiKey: () => Promise<{ ok: boolean; model?: string; error?: string }>;
}

// The same ordering rule as the Cue Card (settingsFeed.ts): a read that
// lands after a newer push never replaces it.
const feed = createSettingsFeed<AppSettings>((settings) => useSettingsStore.setState({ settings }));
const read = () => feed.request(api.settings.get() as Promise<AppSettings>);

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  receive: (settings) => feed.push(settings),
  load: async () => {
    set({ loading: true });
    try {
      await read();
    } finally {
      set({ loading: false });
    }
  },
  saveApiKey: async (key) => {
    await api.settings.setApiKey(key);
    await read();
  },
  clearApiKey: async () => {
    await api.settings.clearApiKey();
    await read();
  },
  testApiKey: () =>
    api.settings.testApiKey() as Promise<{ ok: boolean; model?: string; error?: string }>,
}));
