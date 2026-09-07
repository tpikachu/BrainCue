import Anthropic from '@anthropic-ai/sdk';
import { requireProviderKey } from '../keys';

let _client: Anthropic | null = null;
let _keyFingerprint = '';

/** Cached Anthropic client, rebuilt when the stored key changes (same shape
 *  as `services/openai/client.ts`). Throws the user-safe "needs an API key"
 *  error when none is stored. */
export async function anthropicClient(): Promise<Anthropic> {
  const key = await requireProviderKey('anthropic');
  const fp = `${key.length}:${key.slice(-4)}`;
  if (!_client || fp !== _keyFingerprint) {
    _client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    _keyFingerprint = fp;
  }
  return _client;
}
