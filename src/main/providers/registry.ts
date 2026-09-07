import { cloudProvider } from '@shared/providers';
import { anthropicChat, anthropicVision } from './anthropic';
import { CapabilityUnavailableError } from './errors';
import {
  openaiBatchStt,
  openaiChat,
  openaiEmbedding,
  openaiRealtimeStt,
  openaiSpeech,
  openaiVision,
} from './openai';
import { openaiCompatibleProvider } from './openaiCompatible';
import { createRouted } from './routed';
import type { Capability, CapabilityMap } from './types';

/**
 * Resolves the selected provider per capability. Mix-and-match by capability
 * is the PRD §6.7 contract (e.g. a cheaper provider for classification, a
 * stronger one for answers). `chat` and `vision` select the ROUTED
 * implementation, which dispatches PER TASK on the model the user picked
 * (`anthropic/claude-opus-5` → Anthropic's adapter, a bare id → OpenAI; see
 * providers/routed.ts and models.ts `resolveModel`). Embedding, realtime
 * STT, batch STT and speech still select OpenAI. Registration is data, so
 * tests can register fakes and features can probe availability before
 * depending on a capability.
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

/** Selected provider per capability. Mutable for tests/future Settings.
 *  `routed` = per-task dispatch (the user picks a model per task, and the
 *  model's provider prefix decides); everything else is the reference
 *  implementation. */
const selection: Record<Capability, string> = {
  chat: 'routed',
  embedding: 'openai',
  realtimeStt: 'openai',
  batchStt: 'openai',
  speech: 'openai',
  vision: 'routed',
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

// Multi-provider v1 (milestone 5.1): Anthropic natively; Google / Groq /
// OpenRouter through the one OpenAI-compatible adapter. Adapters resolve
// their key lazily, so registering them costs nothing until a task routes
// there — and a missing key surfaces as "<Provider> needs an API key…".
registerProvider('anthropic', 'chat', anthropicChat);
registerProvider('anthropic', 'vision', anthropicVision);
for (const id of ['google', 'groq', 'openrouter'] as const) {
  const info = cloudProvider(id);
  if (!info) continue;
  const { chat, vision } = openaiCompatibleProvider(info);
  registerProvider(id, 'chat', chat);
  if (vision) registerProvider(id, 'vision', vision);
}

// The per-task router looks providers up in this same table.
const { routedChat, routedVision } = createRouted((provider, capability) =>
  registrations.get(keyOf(provider, capability)),
);
registerProvider('routed', 'chat', routedChat);
registerProvider('routed', 'vision', routedVision);
