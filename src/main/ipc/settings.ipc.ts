import { z } from 'zod';
import { app } from 'electron';
import { IPC } from '@shared/ipc';
import type { AppSettings, OverlayPrefs } from '@shared/types';
import { handle, NoInput } from './helpers';
import { apiKeyStore } from '../services/security/apiKey';
import { listModels, testApiKey } from '../services/openai/client';
import { defaultModels } from '../services/openai/models';
import { SETTINGS_KEYS, settingsRepo } from '../db/repositories/settings.repo';
import {
  getShortcuts,
  registerGlobalShortcuts,
  resetShortcuts,
  setShortcuts,
  unregisterGlobalShortcuts,
} from '../shortcuts';
import { SHORTCUT_DEFAULTS } from '@shared/shortcuts';
import { broadcast } from './broadcast';
import { EVENTS } from '@shared/ipc';

const defaultOverlay: OverlayPrefs = { opacity: 0.95, fontSize: 14, mode: 'compact' };

function readSettings(): AppSettings {
  return {
    apiKeyPresent: apiKeyStore.isPresent(),
    models: settingsRepo.getJson(SETTINGS_KEYS.models, {}),
    modelDefaults: { ...defaultModels },
    overlay: settingsRepo.getJson(SETTINGS_KEYS.overlayPrefs, defaultOverlay),
    privacyMode: settingsRepo.get(SETTINGS_KEYS.privacyMode) !== '0',
    dataConsentAck: settingsRepo.get(SETTINGS_KEYS.dataConsentAck) === '1',
    tourDone: settingsRepo.get(SETTINGS_KEYS.tourDone) === '1',
    shortcuts: getShortcuts(),
    shortcutDefaults: { ...SHORTCUT_DEFAULTS },
  };
}

const settingsPatch = z.object({
  models: z.record(z.string()).optional(),
  overlay: z
    .object({
      opacity: z.number().min(0).max(1),
      fontSize: z.number().min(8).max(48),
      mode: z.enum(['compact', 'expanded']),
    })
    .optional(),
  dataConsentAck: z.boolean().optional(),
  tourDone: z.boolean().optional(),
});

export function registerSettingsIpc(): void {
  handle(IPC.app.getInfo, NoInput, () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  handle(IPC.settings.get, NoInput, () => readSettings());

  handle(IPC.settings.set, settingsPatch, (patch) => {
    if (patch.models) settingsRepo.setJson(SETTINGS_KEYS.models, patch.models);
    if (patch.overlay) {
      settingsRepo.setJson(SETTINGS_KEYS.overlayPrefs, patch.overlay);
      broadcast(EVENTS.overlayApplySettings, patch.overlay, ['overlay']);
    }
    if (patch.dataConsentAck !== undefined)
      settingsRepo.set(SETTINGS_KEYS.dataConsentAck, patch.dataConsentAck ? '1' : '0');
    if (patch.tourDone !== undefined)
      settingsRepo.set(SETTINGS_KEYS.tourDone, patch.tourDone ? '1' : '0');
    return readSettings();
  });

  handle(IPC.settings.setApiKey, z.object({ key: z.string().min(1) }), ({ key }) => {
    apiKeyStore.set(key);
    return { apiKeyPresent: true };
  });

  handle(IPC.settings.clearApiKey, NoInput, () => {
    apiKeyStore.clear();
    return { apiKeyPresent: false };
  });

  handle(IPC.settings.testApiKey, NoInput, () => testApiKey());

  handle(IPC.settings.listModels, NoInput, () => listModels());

  // Re-binds the global shortcuts live (no restart needed).
  handle(
    IPC.settings.setShortcuts,
    z.object({ shortcuts: z.record(z.string()) }),
    ({ shortcuts }) => ({ shortcuts: setShortcuts(shortcuts) }),
  );

  handle(IPC.settings.resetShortcuts, NoInput, () => ({ shortcuts: resetShortcuts() }));

  // While the Settings UI records a new binding, suspend global shortcuts so the
  // keystroke reaches the renderer instead of firing an existing global.
  handle(IPC.settings.suspendShortcuts, NoInput, () => {
    unregisterGlobalShortcuts();
    return { suspended: true as const };
  });
  handle(IPC.settings.resumeShortcuts, NoInput, () => {
    registerGlobalShortcuts();
    return { resumed: true as const };
  });
}
