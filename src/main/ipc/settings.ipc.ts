import { z } from 'zod';
import { app } from 'electron';
import { IPC } from '@shared/ipc';
import type { AppSettings, AudioPrefs, OverlayPrefs } from '@shared/types';
import { handle, NoInput } from './helpers';
import { apiKeyStore } from '../services/security/apiKey';
import { listModels, testApiKey } from '../services/openai/client';
import { defaultEfforts, modelPreset, presetModels } from '../services/openai/models';
import { SETTINGS_KEYS, settingsRepo } from '../db/repositories/settings.repo';
import { readCompanionPrefs } from '../services/engine/modes/companion.mode';
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
import { confirmDestructive } from './data.ipc';
import { applyContentProtectionToAll, getPrivacy } from '../services/session/privacy';
import { appEvents, APP_EVENT } from '../appEvents';
import { getMainWindow } from '../windows/mainWindow';

const defaultOverlay: OverlayPrefs = { opacity: 0.95, fontSize: 14, mode: 'compact' };
const defaultAudio: AudioPrefs = { source: 'system', micDeviceId: null };

function readSettings(): AppSettings {
  return {
    apiKeyPresent: apiKeyStore.isPresent(),
    models: settingsRepo.getJson(SETTINGS_KEYS.models, {}),
    modelPreset: modelPreset(),
    modelDefaults: { ...presetModels() }, // effective per-task defaults for the active preset
    reasoningEfforts: settingsRepo.getJson(SETTINGS_KEYS.reasoningEfforts, {}),
    reasoningEffortDefaults: { ...defaultEfforts },
    overlay: settingsRepo.getJson(SETTINGS_KEYS.overlayPrefs, defaultOverlay),
    audio: settingsRepo.getJson(SETTINGS_KEYS.audioPrefs, defaultAudio),
    codingLanguage: settingsRepo.get(SETTINGS_KEYS.codingLanguage) || 'javascript',
    privacyMode: settingsRepo.get(SETTINGS_KEYS.privacyMode) !== '0',
    hideTaskbarIcon: settingsRepo.get(SETTINGS_KEYS.hideTaskbarIcon) === '1',
    dataConsentAck: settingsRepo.get(SETTINGS_KEYS.dataConsentAck) === '1',
    memoryEnabled: settingsRepo.get(SETTINGS_KEYS.memoryEnabled) === '1', // consent: OFF until enabled
    companionPrefs: readCompanionPrefs(),
    tourDone: settingsRepo.get(SETTINGS_KEYS.tourDone) === '1',
    shortcuts: getShortcuts(),
    shortcutDefaults: { ...SHORTCUT_DEFAULTS },
  };
}

const settingsPatch = z.object({
  models: z.record(z.string()).optional(),
  modelPreset: z.enum(['balanced', 'low_cost', 'best']).optional(),
  reasoningEfforts: z.record(z.string()).optional(),
  overlay: z
    .object({
      opacity: z.number().min(0).max(1),
      fontSize: z.number().min(8).max(48),
      mode: z.enum(['compact', 'expanded']),
    })
    .optional(),
  audio: z
    .object({
      source: z.enum(['system', 'mic']),
      micDeviceId: z.string().nullable(),
    })
    .optional(),
  codingLanguage: z.string().min(1).max(40).optional(),
  dataConsentAck: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  companionPrefs: z
    .object({
      personality: z.object({
        name: z.string().min(1).max(40),
        voice: z.string().nullable(),
        tone: z.enum(['warm', 'neutral', 'direct']),
        brevity: z.enum(['terse', 'normal', 'chatty']),
        humor: z.boolean(),
      }),
      presence: z.enum(['off', 'on_demand', 'assistive', 'proactive']),
      dnd: z
        .array(
          z.object({
            startMin: z.number().int().min(0).max(1439),
            endMin: z.number().int().min(0).max(1439),
          }),
        )
        .max(4),
      budgetCents: z.number().int().positive().nullable(),
    })
    .optional(),
  tourDone: z.boolean().optional(),
  hideTaskbarIcon: z.boolean().optional(),
});

export function registerSettingsIpc(): void {
  handle(IPC.app.getInfo, NoInput, () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  handle(IPC.settings.get, NoInput, () => readSettings());

  handle(IPC.settings.set, settingsPatch, (patch) => {
    if (patch.models) settingsRepo.setJson(SETTINGS_KEYS.models, patch.models);
    if (patch.modelPreset) settingsRepo.set(SETTINGS_KEYS.modelPreset, patch.modelPreset);
    if (patch.reasoningEfforts)
      settingsRepo.setJson(SETTINGS_KEYS.reasoningEfforts, patch.reasoningEfforts);
    if (patch.overlay) {
      settingsRepo.setJson(SETTINGS_KEYS.overlayPrefs, patch.overlay);
      broadcast(EVENTS.overlayApplySettings, patch.overlay, ['overlay']);
    }
    if (patch.audio) settingsRepo.setJson(SETTINGS_KEYS.audioPrefs, patch.audio);
    if (patch.codingLanguage !== undefined)
      settingsRepo.set(SETTINGS_KEYS.codingLanguage, patch.codingLanguage);
    if (patch.hideTaskbarIcon !== undefined) {
      settingsRepo.set(SETTINGS_KEYS.hideTaskbarIcon, patch.hideTaskbarIcon ? '1' : '0');
      getMainWindow()?.setSkipTaskbar(patch.hideTaskbarIcon);
    }
    if (patch.dataConsentAck !== undefined)
      settingsRepo.set(SETTINGS_KEYS.dataConsentAck, patch.dataConsentAck ? '1' : '0');
    if (patch.memoryEnabled !== undefined)
      settingsRepo.set(SETTINGS_KEYS.memoryEnabled, patch.memoryEnabled ? '1' : '0');
    if (patch.companionPrefs)
      settingsRepo.setJson(SETTINGS_KEYS.companionPrefs, patch.companionPrefs);
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

  // Factory-reset every setting (models, overlay, privacy, shortcuts, consent,
  // tour) to defaults. Keeps the API key and user data (cleared via data:wipe-all).
  handle(IPC.settings.resetApp, NoInput, async () => {
    const ok = await confirmDestructive({
      message: 'Reset all settings to defaults?',
      detail:
        'Models, overlay, privacy, keyboard shortcuts, and other preferences return to factory defaults. Your API key, profiles, and sessions are kept.',
      confirmLabel: 'Reset settings',
    });
    if (!ok) return { reset: false as const, settings: readSettings() };

    settingsRepo.resetApp();

    // Re-apply the now-default state live: shortcuts back to defaults, privacy
    // back to its default (ON), and the overlay back to default prefs.
    unregisterGlobalShortcuts();
    registerGlobalShortcuts();
    applyContentProtectionToAll(getPrivacy());
    broadcast(EVENTS.privacyChanged, { enabled: getPrivacy() });
    appEvents.emit(APP_EVENT.privacyChanged, getPrivacy());
    broadcast(EVENTS.overlayApplySettings, defaultOverlay, ['overlay']);
    getMainWindow()?.setSkipTaskbar(false); // back to the default (shown)

    return { reset: true as const, settings: readSettings() };
  });
}
