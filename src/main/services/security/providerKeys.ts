import { safeStorage } from 'electron';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { CLOUD_PROVIDERS, type CloudProviderId } from '@shared/providers';
import { apiKeyStore } from './apiKey';
import { log } from './logger';

/**
 * Per-provider API keys, with exactly the rules the OpenAI key has always had
 * (docs/07-API-KEY-SECURITY.md): main process only, safeStorage-encrypted at
 * rest, and `getDecrypted` is never returned over IPC — the renderer learns a
 * boolean per provider and nothing more.
 *
 * `openai` delegates to `apiKeyStore` so there is ONE OpenAI key, wherever it
 * was entered (the old field, the new Language Models panel, or the env var).
 */
export const providerKeys = {
  isPresent(provider: CloudProviderId): boolean {
    if (provider === 'openai') return apiKeyStore.isPresent();
    return settingsRepo.get(SETTINGS_KEYS.providerKeyPresent(provider)) === '1';
  },

  /** Boolean per provider — the only shape that crosses to the renderer. */
  presence(): Record<CloudProviderId, boolean> {
    const out = {} as Record<CloudProviderId, boolean>;
    for (const p of CLOUD_PROVIDERS) out[p.id] = providerKeys.isPresent(p.id);
    return out;
  },

  set(provider: CloudProviderId, plaintext: string): void {
    if (provider === 'openai') return apiKeyStore.set(plaintext);
    const key = plaintext.trim();
    if (!key) throw new Error('Empty API key');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable on this OS. Cannot store the API key safely.');
    }
    settingsRepo.set(
      SETTINGS_KEYS.providerKeyEnc(provider),
      safeStorage.encryptString(key).toString('base64'),
    );
    settingsRepo.set(SETTINGS_KEYS.providerKeyPresent(provider), '1');
    log.info(`${provider} key stored (encrypted)`);
  },

  clear(provider: CloudProviderId): void {
    if (provider === 'openai') return apiKeyStore.clear();
    settingsRepo.delete(SETTINGS_KEYS.providerKeyEnc(provider));
    settingsRepo.set(SETTINGS_KEYS.providerKeyPresent(provider), '0');
    log.info(`${provider} key cleared`);
  },

  /** MAIN-PROCESS ONLY. */
  getDecrypted(provider: CloudProviderId): string | null {
    if (provider === 'openai') return apiKeyStore.getDecrypted();
    const enc = settingsRepo.get(SETTINGS_KEYS.providerKeyEnc(provider));
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch (e) {
      log.error(`failed to decrypt stored ${provider} key`, e);
      return null;
    }
  },
};
