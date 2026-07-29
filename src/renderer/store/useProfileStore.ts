import { create } from 'zustand';
import { api } from '../lib/api';
import type { AppSettings, Profile, ProfileInput } from '@shared/types';

/**
 * Whose dashboard this is.
 *
 * Every profile-scoped surface used to ask again: the Library's four tabs, the
 * start modal, and each interview page all carried their own `useState('')`
 * plus a "default to profiles[0]" effect plus a `<Select>`. Five pickers for
 * one fact, free to disagree — you could be reading one person's Spaces while
 * the start modal was primed to run a session as someone else.
 *
 * So the profile is chosen ONCE, in the sidebar, and persisted in main
 * (`AppSettings.activeProfileId`) so it survives a restart and every window
 * agrees. Main resolves it against the real rows, so a profile deleted from
 * under the pointer falls back to one that exists rather than leaving every
 * surface silently empty.
 */
interface ProfileState {
  profiles: Profile[];
  /** null before the first load resolves, and when no profile exists (first run). */
  activeId: string | null;
  /** Distinguishes "still loading" from "there are genuinely none" — the
   *  difference between showing nothing and demanding a profile be created. */
  loaded: boolean;
  load: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
  create: (input: ProfileInput) => Promise<Profile>;
  remove: (id: string) => Promise<void>;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  activeId: null,
  loaded: false,

  load: async () => {
    const [profiles, settings] = await Promise.all([
      api.profiles.list() as Promise<Profile[]>,
      api.settings.get() as Promise<AppSettings>,
    ]);
    set({ profiles, activeId: settings.activeProfileId, loaded: true });
  },

  setActive: async (id) => {
    // Optimistic: switching must feel instant. Main decides what is valid, so
    // the response reconciles rather than the renderer assuming it won.
    set({ activeId: id });
    const settings = (await api.settings.set({ activeProfileId: id })) as AppSettings;
    set({ activeId: settings.activeProfileId });
  },

  create: async (input) => {
    const profile = (await api.profiles.create(input)) as Profile;
    // A profile you just made is the one you meant to use.
    await api.settings.set({ activeProfileId: profile.id });
    await get().load();
    return profile;
  },

  remove: async (id) => {
    await api.profiles.delete(id);
    // Deleting the active profile leaves main to pick the fallback; reloading
    // is what adopts it, rather than the UI guessing.
    await get().load();
  },
}));

/** The active profile row, or undefined before the first load resolves. */
export const useActiveProfile = (): Profile | undefined =>
  useProfileStore((s) => s.profiles.find((p) => p.id === s.activeId));
