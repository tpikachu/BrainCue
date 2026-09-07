import { providerKeys } from '../services/security/providerKeys';
import { applySttSelection, readSttPrefs, sttReady, writeSttPrefs } from '../services/stt';
import { DEFAULT_STT_PREFS, localSttModel } from '@shared/stt';
import { testProviderKey } from '../providers/testKey';
import { listProviderModels } from '../providers/listModels';
import { z } from 'zod';
import { app } from 'electron';
import { IPC } from '@shared/ipc';
import type { AppSettings, AudioPrefs, OverlayPrefs } from '@shared/types';
import { handle, NoInput } from './helpers';
import { apiKeyStore } from '../services/security/apiKey';
import { listModels, testApiKey } from '../services/openai/client';
import { defaultEfforts, modelPreset, presetModels } from '../services/openai/models';
import { SETTINGS_KEYS, settingsRepo } from '../db/repositories/settings.repo';
import { profilesRepo } from '../db/repositories/profiles.repo';
import { readCompanionPrefs } from '../services/engine/modes/companion.mode';
import {
  getShortcuts,
  registerGlobalShortcuts,
  resetShortcuts,
  setShortcuts,
  unregisterGlobalShortcuts,
} from '../shortcuts';
import { SHORTCUT_DEFAULTS } from '@shared/shortcuts';
import { resolveActiveProfile } from '@shared/activeProfile';
import { broadcast } from './broadcast';
import { EVENTS } from '@shared/ipc';
import { confirmDestructive } from './data.ipc';
import { applyContentProtectionToAll, getPrivacy } from '../services/session/privacy';
import { appEvents, APP_EVENT } from '../appEvents';
import { getMainWindow } from '../windows/mainWindow';

const defaultOverlay: OverlayPrefs = { opacity: 0.95, fontSize: 14, mode: 'compact' };
const defaultAudio: AudioPrefs = { source: 'system', micDeviceId: null };

/** Resolved HERE rather than in the renderer so every window agrees on whose
 *  dashboard this is — including the Cue Card, which has no picker at all. */
const activeProfileId = (): string | null =>
  resolveActiveProfile(
    settingsRepo.get(SETTINGS_KEYS.activeProfileId),
    profilesRepo.list().map((p) => p.id),
  );

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
    // Continuity defaults ON (absent = on): it summarises sessions the user
    // ran, from transcripts already stored locally — a much smaller step than
    // memory, which extracts standing claims about the person.
    sessionArchiveEnabled: settingsRepo.get(SETTINGS_KEYS.sessionArchiveEnabled) !== '0',
    devDbExplorer: settingsRepo.get(SETTINGS_KEYS.devDbExplorer) === '1', // support tool: OFF unless asked for
    // Whose dashboard this is. Validated against the real rows: a profile can
    // be deleted from under the pointer, and a dangling id would leave every
    // surface silently empty rather than falling back to a profile that exists.
    activeProfileId: activeProfileId(),
    companionPrefs: readCompanionPrefs(),
    tourDone: settingsRepo.get(SETTINGS_KEYS.tourDone) === '1',
    onboardingDone: settingsRepo.get(SETTINGS_KEYS.onboardingDone) === '1',
    providerKeys: providerKeys.presence(),
    stt: readSttPrefs(),
    sttReady: sttReady(),
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
      // Legacy: a session now hears the call AND the microphone, so nothing
      // writes this; still accepted from older renderers / stored JSON.
      source: z.enum(['system', 'mic']).optional(),
      micDeviceId: z.string().nullable(),
    })
    .optional(),
  codingLanguage: z.string().min(1).max(40).optional(),
  dataConsentAck: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  sessionArchiveEnabled: z.boolean().optional(),
  devDbExplorer: z.boolean().optional(),
  activeProfileId: z.string().min(1).nullable().optional(),
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
  onboardingDone: z.boolean().optional(),
  stt: z
    .object({
      engine: z.enum(['cloud', 'local']),
      localModelId: z.string().min(1).max(80),
    })
    .optional(),
  hideTaskbarIcon: z.boolean().optional(),
});

const providerId = z.enum(['openai', 'anthropic', 'google', 'groq', 'openrouter']);

export function registerSettingsIpc(): void {
  handle(IPC.app.getInfo, NoInput, () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  handle(IPC.settings.get, NoInput, () => readSettings());

  handle(IPC.settings.set, settingsPatch, (patch) => {
    if (patch.activeProfileId !== undefined)
      settingsRepo.set(SETTINGS_KEYS.activeProfileId, patch.activeProfileId ?? '');
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
    if (patch.sessionArchiveEnabled !== undefined)
      settingsRepo.set(
        SETTINGS_KEYS.sessionArchiveEnabled,
        patch.sessionArchiveEnabled ? '1' : '0',
      );
    if (patch.companionPrefs)
      settingsRepo.setJson(SETTINGS_KEYS.companionPrefs, patch.companionPrefs);
    if (patch.devDbExplorer !== undefined)
      settingsRepo.set(SETTINGS_KEYS.devDbExplorer, patch.devDbExplorer ? '1' : '0');
    if (patch.tourDone !== undefined)
      settingsRepo.set(SETTINGS_KEYS.tourDone, patch.tourDone ? '1' : '0');
    if (patch.onboardingDone !== undefined)
      settingsRepo.set(SETTINGS_KEYS.onboardingDone, patch.onboardingDone ? '1' : '0');
    if (patch.stt) {
      // Unknown model ids fall back to the default inside readSttPrefs, so a
      // stale renderer can never persist an engine with nothing to run.
      writeSttPrefs({ ...patch.stt, localModelId: localSttModel(patch.stt.localModelId) ? patch.stt.localModelId : DEFAULT_STT_PREFS.localModelId });
      applySttSelection();
    }
    return readSettings();
  });

  // Per-provider keys: same isolation as the OpenAI key (main only, encrypted,
  // booleans over the wire). `openai` here IS the OpenAI key.
  handle(
    IPC.settings.setProviderKey,
    z.object({ provider: providerId, key: z.string().min(1) }),
    ({ provider, key }) => {
      providerKeys.set(provider, key);
      return { providerKeys: providerKeys.presence() };
    },
  );
  handle(IPC.settings.clearProviderKey, z.object({ provider: providerId }), ({ provider }) => {
    providerKeys.clear(provider);
    return { providerKeys: providerKeys.presence() };
  });
  handle(IPC.settings.testProviderKey, z.object({ provider: providerId }), ({ provider }) =>
    testProviderKey(provider),
  );

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
  handle(IPC.settings.listProviderModels, z.object({ provider: providerId }), ({ provider }) =>
    listProviderModels(provider),
  );

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
