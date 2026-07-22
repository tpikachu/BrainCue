import { eq } from 'drizzle-orm';
import { db, schema } from '../index';

/** Raw key/value access to the settings table. */
export const settingsRepo = {
  get(key: string): string | null {
    const row = db().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    db()
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  },

  delete(key: string): void {
    db().delete(schema.settings).where(eq(schema.settings.key, key)).run();
  },

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  },

  /** Factory-reset app settings: clear every non-secret setting key so they fall
   *  back to their built-in defaults. Deliberately KEEPS the encrypted API key
   *  (that's "user data", cleared separately by the data wipe). */
  resetApp(): void {
    for (const key of APP_SETTING_KEYS) this.delete(key);
  },
};

export const SETTINGS_KEYS = {
  apiKeyEnc: 'openai_api_key_enc',
  apiKeyPresent: 'openai_api_key_present',
  models: 'models',
  modelPreset: 'model_preset',
  reasoningEfforts: 'reasoning_efforts',
  overlayPrefs: 'overlay_prefs',
  privacyMode: 'privacy_mode',
  dataConsentAck: 'data_consent_ack',
  tourDone: 'tour_done',
  shortcuts: 'shortcuts',
  overlayBounds: 'overlay_bounds',
  audioPrefs: 'audio_prefs',
  hideTaskbarIcon: 'hide_taskbar_icon',
  codingLanguage: 'coding_language',
  memoryEnabled: 'memory_enabled', // global memory consent ('1'/'0'; absent = off)
} as const;

/** Non-secret settings cleared by a factory reset (everything except the API key). */
const APP_SETTING_KEYS: string[] = [
  SETTINGS_KEYS.models,
  SETTINGS_KEYS.modelPreset,
  SETTINGS_KEYS.reasoningEfforts,
  SETTINGS_KEYS.overlayPrefs,
  SETTINGS_KEYS.privacyMode,
  SETTINGS_KEYS.dataConsentAck,
  SETTINGS_KEYS.tourDone,
  SETTINGS_KEYS.shortcuts,
  SETTINGS_KEYS.overlayBounds,
  SETTINGS_KEYS.audioPrefs,
  SETTINGS_KEYS.hideTaskbarIcon,
  SETTINGS_KEYS.codingLanguage,
  SETTINGS_KEYS.memoryEnabled,
];
