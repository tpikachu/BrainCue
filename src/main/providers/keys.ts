import { cloudProvider, type CloudProviderId } from '@shared/providers';

/**
 * Key access for the non-OpenAI adapters. MAIN PROCESS ONLY — the same rules
 * as the OpenAI key (docs/07-API-KEY-SECURITY.md): decrypted at call time,
 * never over IPC, never logged.
 *
 * The key store is imported lazily: `providerKeys` pulls in electron's
 * safeStorage and the settings DB, and the provider registry (which registers
 * every adapter at load) must stay importable in node unit tests. The import
 * only runs when a non-OpenAI provider is actually used.
 */
export function missingKeyMessage(provider: CloudProviderId): string {
  const name = cloudProvider(provider)?.name ?? provider;
  return `${name} needs an API key — add one in Settings → Language Models.`;
}

export async function requireProviderKey(provider: CloudProviderId): Promise<string> {
  const { providerKeys } = await import('../services/security/providerKeys');
  const key = providerKeys.getDecrypted(provider);
  if (!key) throw new Error(missingKeyMessage(provider));
  return key;
}
