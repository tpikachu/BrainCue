import OpenAI from 'openai';
import type { CloudProviderInfo } from '@shared/providers';
import { requireProviderKey } from '../keys';

const cache = new Map<string, { fingerprint: string; client: OpenAI }>();

/** OpenRouter asks callers to identify their app; harmless elsewhere so only
 *  sent there. */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://braincue.app', 'X-Title': 'BrainCue' };

/** Cached OpenAI-SDK client pointed at the vendor's OpenAI-shaped base URL,
 *  rebuilt when that provider's stored key changes. */
export async function compatClient(info: CloudProviderInfo): Promise<OpenAI> {
  const key = await requireProviderKey(info.id);
  const fingerprint = `${key.length}:${key.slice(-4)}`;
  const hit = cache.get(info.id);
  if (hit && hit.fingerprint === fingerprint) return hit.client;
  const client = new OpenAI({
    apiKey: key,
    baseURL: info.baseUrl,
    maxRetries: 2,
    timeout: 60_000,
    ...(info.id === 'openrouter' ? { defaultHeaders: OPENROUTER_HEADERS } : {}),
  });
  cache.set(info.id, { fingerprint, client });
  return client;
}
