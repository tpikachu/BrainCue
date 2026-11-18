import { CLOUD_PROVIDERS, type CloudProviderId } from '@shared/providers';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { listProviderModels } from '../../providers/listModels';
import { providerKeys } from '../security/providerKeys';
import { log } from '../security/logger';
import type { DiscoveryEntry } from '../openai/models';

/**
 * Model discovery: which model ids each configured provider actually serves
 * to THIS account (the vendor's own GET /models — no tokens spent).
 *
 * The policy (shared/modelPolicy.ts) filters its candidates by this list so
 * a model the account cannot use is never selected — the failure mode that
 * silently disabled question detection when gpt-4.1-nano was retired.
 *
 * Off the hot path by construction: refreshed in the background at startup
 * and when a key changes, read synchronously from settings at resolution
 * time. A failed refresh keeps the previous list (and a list older than a
 * week stops filtering at all — models.ts DISCOVERY_MAX_AGE_MS).
 */

/** Refresh a provider's list at most this often in the background. */
export const DISCOVERY_REFRESH_MS = 24 * 60 * 60 * 1000;

function read(): Record<string, DiscoveryEntry> {
  return settingsRepo.getJson<Record<string, DiscoveryEntry>>(SETTINGS_KEYS.modelDiscovery, {}) ?? {};
}

export function storeDiscovery(provider: CloudProviderId, ids: string[]): void {
  if (ids.length === 0) return; // an empty list would disqualify everything
  settingsRepo.setJson(SETTINGS_KEYS.modelDiscovery, { ...read(), [provider]: { ids, at: Date.now() } });
}

export function clearDiscovery(provider: CloudProviderId): void {
  const all = read();
  delete all[provider];
  settingsRepo.setJson(SETTINGS_KEYS.modelDiscovery, all);
}

export function discoveryAge(provider: CloudProviderId): number | null {
  const e = read()[provider];
  return e ? Date.now() - e.at : null;
}

/** Refresh the lists of providers that have a key. `force` ignores the
 *  24 h freshness window (a key was just added). Never throws. */
export async function refreshDiscovery(only?: CloudProviderId[], force = false): Promise<void> {
  const targets = (only ?? CLOUD_PROVIDERS.map((p) => p.id)).filter((p) => providerKeys.isPresent(p));
  await Promise.all(
    targets.map(async (p) => {
      const age = discoveryAge(p);
      if (!force && age !== null && age < DISCOVERY_REFRESH_MS) return;
      try {
        storeDiscovery(p, await listProviderModels(p));
      } catch (e) {
        // Counts and provider only — the error text is already user-safe.
        log.warn(`model discovery failed for ${p}; keeping the previous list`, e);
      }
    }),
  );
}

/** Kick off a background refresh shortly after startup. */
export function scheduleDiscovery(delayMs = 8000): void {
  setTimeout(() => void refreshDiscovery(), delayMs).unref?.();
}
