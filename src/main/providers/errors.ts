import type { Capability } from './types';

const CAPABILITY_LABEL: Record<Capability, string> = {
  chat: 'answer generation',
  embedding: 'document indexing (embeddings)',
  realtimeStt: 'live transcription',
  batchStt: 'audio transcription',
  speech: 'voice output',
  vision: 'screenshot reading',
};

/** A mode/feature needs a capability the selected provider doesn't offer.
 *  The message is user-safe — it surfaces verbatim in the session-error
 *  banner (PRD §6.7: capability gaps degrade clearly, never silently). */
export class CapabilityUnavailableError extends Error {
  constructor(
    readonly capability: Capability,
    readonly provider: string,
  ) {
    super(
      `${CAPABILITY_LABEL[capability]} isn't available from the '${provider}' provider. ` +
        `Switch the ${capability} provider in Settings.`,
    );
    this.name = 'CapabilityUnavailableError';
  }
}

/** The local vector index was built with a different embedding identity —
 *  mixing spaces would silently break retrieval, so the write path refuses. */
export class EmbeddingIdentityMismatchError extends Error {
  constructor(stored: string, current: string) {
    super(
      `Your documents were indexed with a different embedding model (${stored}) than the ` +
        `current one (${current}). Re-index your profiles (or restore the previous embedding ` +
        `model in Settings) before adding new documents.`,
    );
    this.name = 'EmbeddingIdentityMismatchError';
  }
}
