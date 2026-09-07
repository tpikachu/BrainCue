import { cloudProvider, type CloudProviderId } from '@shared/providers';
import { testApiKey } from '../services/openai/client';
import { anthropicClient } from './anthropic/client';
import { normalizeProviderError } from './normalizeError';
import { compatClient } from './openaiCompatible/client';
import { normalizeCompatError } from './openaiCompatible';

/**
 * Cheap authenticated call per provider so Settings can say "works" or show
 * the vendor's error — `GET /models` everywhere (every vendor here serves
 * it, and it costs no tokens). Errors are user-safe and never carry the key.
 */
export async function testProviderKey(
  provider: CloudProviderId,
): Promise<{ ok: boolean; model?: string; error?: string }> {
  if (provider === 'openai') return testApiKey();
  const info = cloudProvider(provider);
  if (!info) return { ok: false, error: 'Unknown provider.' };
  if (info.transport === 'anthropic') {
    try {
      const page = await (await anthropicClient()).models.list({ limit: 1 });
      return { ok: true, model: page.data[0]?.id };
    } catch (e) {
      return { ok: false, error: normalizeProviderError(e) };
    }
  }
  try {
    const res = await (await compatClient(info)).models.list();
    return { ok: true, model: res.data[0]?.id };
  } catch (e) {
    return { ok: false, error: normalizeCompatError(info, e) };
  }
}
