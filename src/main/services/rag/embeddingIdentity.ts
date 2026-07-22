import { db, schema } from '../../db';
import { EmbeddingIdentityMismatchError } from '../../providers/errors';
import type { EmbeddingIdentity } from '../../providers/types';

/**
 * Refuse to MIX embedding spaces: vectors from different provider/model pairs
 * are not comparable, and silently interleaving them would corrupt retrieval
 * for every session. Called on every write path before new vectors are
 * created. Switching the embedding provider/model therefore requires a
 * re-index — the requirement is explicit in the domain (PRD §6.7) even though
 * the guided re-index UI ships later.
 */
export function assertEmbeddingCompatibility(identity: EmbeddingIdentity): void {
  const existing = db()
    .select({ provider: schema.embeddings.provider, model: schema.embeddings.model })
    .from(schema.embeddings)
    .limit(1)
    .get();
  if (!existing) return; // empty index — any identity may seed it
  if (existing.provider !== identity.provider || existing.model !== identity.model) {
    throw new EmbeddingIdentityMismatchError(
      `${existing.provider}/${existing.model}`,
      `${identity.provider}/${identity.model}`,
    );
  }
}
