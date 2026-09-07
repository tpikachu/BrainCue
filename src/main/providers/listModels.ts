import { cloudProvider, type CloudProviderId } from '@shared/providers';
import { listModels as listOpenAIModels } from '../services/openai/client';
import { anthropicClient } from './anthropic/client';
import { normalizeProviderError } from './normalizeError';
import { compatClient } from './openaiCompatible/client';
import { normalizeCompatError } from './openaiCompatible';

/**
 * Every model the stored key can see, per provider — `GET /models` on each
 * vendor (the same call `testProviderKey` makes; it costs no tokens). The
 * Settings picker merges these under the curated catalog so a user with a
 * key sees the vendor's whole list, not only the handful we describe.
 *
 * The vendor lists mix in models that cannot serve a chat task (embeddings,
 * speech, image, moderation, legacy completion models); those are filtered
 * out by id so the picker does not offer a TTS voice as the live cue.
 */
const NON_CHAT =
  /embed|tts|whisper|transcri|realtime|moderation|dall-e|image|audio|sora|veo|imagen|aqa|bison|gecko|guard|rerank|distil|playai|orpheus|davinci|babbage|curie|(^|\/)ada|instruct|computer-use|search|codex-mini|-ft-|:ft-/i;

/** `gpt-4.1-2025-04-14` next to `gpt-4.1`: the dated snapshot adds nothing to
 *  a picker (the alias is what people choose) and doubles the list. */
const DATED = /-\d{4}-\d{2}-\d{2}$/;

export function dropDatedDuplicates(ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !(DATED.test(id) && set.has(id.replace(DATED, ''))));
}

export function isChatModelId(id: string): boolean {
  return !NON_CHAT.test(id);
}

export async function listProviderModels(provider: CloudProviderId): Promise<string[]> {
  const info = cloudProvider(provider);
  if (!info) throw new Error('Unknown provider.');
  let ids: string[];
  if (provider === 'openai') {
    ids = await listOpenAIModels();
  } else if (info.transport === 'anthropic') {
    try {
      const client = await anthropicClient();
      ids = [];
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    } catch (e) {
      throw new Error(normalizeProviderError(e));
    }
  } else {
    try {
      const res = await (await compatClient(info)).models.list();
      ids = res.data.map((m) => m.id);
    } catch (e) {
      throw new Error(normalizeCompatError(info, e));
    }
  }
  return dropDatedDuplicates(Array.from(new Set(ids.filter(isChatModelId))).sort());
}
