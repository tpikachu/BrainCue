import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { bufferToVector, cosineSimilarity, vectorToBuffer } from './vectorMath';
import type { ChunkSource, RetrievedChunk } from '@shared/types';

/**
 * VectorStore interface so the backend can be swapped (SQLite cosine -> LanceDB
 * or sqlite-vec) without touching callers. MVP impl: brute-force cosine over
 * embeddings stored as BLOBs in SQLite, filtered by profile.
 */
export interface VectorStore {
  upsert(args: {
    chunkId: string;
    provider: string;
    model: string;
    vector: Float32Array;
  }): void;
  search(args: {
    profileId: string;
    query: Float32Array;
    k: number;
    jobId?: string | null;
  }): RetrievedChunk[];
  /** The single best-matching `story` chunk for the query (or null), regardless of
   *  the top-k. Reuses the caller's query vector so it adds no extra embedding call. */
  topStory(args: { profileId: string; query: Float32Array }): RetrievedChunk | null;
}

export const sqliteVectorStore: VectorStore = {
  upsert({ chunkId, provider, model, vector }) {
    db()
      .insert(schema.embeddings)
      .values({
        id: crypto.randomUUID(),
        chunkId,
        provider,
        model,
        dim: vector.length,
        vector: vectorToBuffer(vector),
      })
      .onConflictDoUpdate({
        target: schema.embeddings.chunkId,
        set: { provider, model, dim: vector.length, vector: vectorToBuffer(vector) },
      })
      .run();
  },

  search({ profileId, query, k, jobId }) {
    // Join chunks (for the profile) with their embeddings, score in-process.
    const rows = db()
      .select({
        id: schema.chunks.id,
        jobId: schema.chunks.packId,
        sourceType: schema.chunks.sourceType,
        content: schema.chunks.content,
        vector: schema.embeddings.vector,
      })
      .from(schema.chunks)
      .innerJoin(schema.embeddings, eq(schema.embeddings.chunkId, schema.chunks.id))
      .where(eq(schema.chunks.profileId, profileId))
      .all();

    // An application job carries `tailored` chunks (the resume rewritten FOR that
    // job) — when present, they REPLACE the base resume for this job's retrieval,
    // so the session grounds in the tailored resume. Notes/stories still apply.
    const hasTailored = rows.some((r) => r.jobId === jobId && r.sourceType === 'tailored');
    const filtered = rows.filter(
      (r) =>
        // Base chunks (resume/notes/stories, jobId null) + the selected job's chunks…
        (r.jobId == null || r.jobId === jobId) &&
        // …minus the base resume when this job has a tailored one.
        !(hasTailored && r.jobId == null && r.sourceType === 'resume'),
    );

    return filtered
      .map((r) => ({
        id: r.id,
        sourceType: r.sourceType as ChunkSource,
        content: r.content,
        score: cosineSimilarity(query, bufferToVector(r.vector as Buffer)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  },

  topStory({ profileId, query }) {
    const rows = db()
      .select({
        id: schema.chunks.id,
        content: schema.chunks.content,
        vector: schema.embeddings.vector,
      })
      .from(schema.chunks)
      .innerJoin(schema.embeddings, eq(schema.embeddings.chunkId, schema.chunks.id))
      .where(and(eq(schema.chunks.profileId, profileId), eq(schema.chunks.sourceType, 'story')))
      .all();

    let best: RetrievedChunk | null = null;
    for (const r of rows) {
      const score = cosineSimilarity(query, bufferToVector(r.vector as Buffer));
      if (!best || score > best.score) {
        best = { id: r.id, sourceType: 'story', content: r.content, score };
      }
    }
    return best;
  },
};
