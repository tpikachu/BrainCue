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
};

export const SETTINGS_KEYS = {
  apiKeyEnc: 'openai_api_key_enc',
  apiKeyPresent: 'openai_api_key_present',
  models: 'models',
  overlayPrefs: 'overlay_prefs',
  privacyMode: 'privacy_mode',
  dataConsentAck: 'data_consent_ack',
  tourDone: 'tour_done',
  shortcuts: 'shortcuts',
} as const;
