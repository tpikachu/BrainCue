import { CapabilityUnavailableError } from './errors';
import {
  openaiBatchStt,
  openaiChat,
  openaiEmbedding,
  openaiRealtimeStt,
  openaiSpeech,
  openaiVision,
} from './openai';
import type { Capability, CapabilityMap } from './types';

/**
 * Resolves the selected provider per capability. Mix-and-match by capability
 * is the PRD §6.7 contract (e.g. a cheaper provider for classification, a
 * stronger one for answers); today every capability selects OpenAI — the
 * per-capability selection UI (Settings → Providers) lands with the second
 * provider. Registration is data, so tests can register fakes and features
 * can probe availability before depending on a capability.
 */

const registrations = new Map<string, unknown>();

const keyOf = (provider: string, capability: Capability) => `${provider}:${capability}`;

export function registerProvider<C extends Capability>(
  provider: string,
  capability: C,
  impl: CapabilityMap[C],
): void {
  registrations.set(keyOf(provider, capability), impl);
}

/** Selected provider per capability. Mutable for tests/future Settings; the
 *  default is the reference implementation for everything. */
const selection: Record<Capability, string> = {
  chat: 'openai',
  embedding: 'openai',
  realtimeStt: 'openai',
  batchStt: 'openai',
  speech: 'openai',
  vision: 'openai',
};

export function setProviderSelection(capability: Capability, provider: string): void {
  selection[capability] = provider;
}

export function providerSelection(capability: Capability): string {
  return selection[capability];
}

export function providerFor<C extends Capability>(capability: C): CapabilityMap[C] {
  const selected = selection[capability];
  const impl = registrations.get(keyOf(selected, capability));
  if (!impl) throw new CapabilityUnavailableError(capability, selected);
  return impl as CapabilityMap[C];
}

// The reference provider registers at module load — every capability works
// out of the box with the user's existing OpenAI key.
registerProvider('openai', 'chat', openaiChat);
registerProvider('openai', 'embedding', openaiEmbedding);
registerProvider('openai', 'realtimeStt', openaiRealtimeStt);
registerProvider('openai', 'batchStt', openaiBatchStt);
registerProvider('openai', 'speech', openaiSpeech);
registerProvider('openai', 'vision', openaiVision);
