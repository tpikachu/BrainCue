import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../../db';
import { chunkText } from './chunker';
import { embed } from '../openai/embeddings';
import { sqliteVectorStore } from './vectorStore';
import { model } from '../openai/models';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { apiKeyStore } from '../security/apiKey';

async function embedChunks(rows: { id: string; content: string }[]): Promise<number> {
  let embedded = 0;
  const BATCH = 64;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await embed(batch.map((b) => b.content));
    batch.forEach((b, j) =>
      sqliteVectorStore.upsert({ chunkId: b.id, model: model('embedding'), vector: vectors[j] }),
    );
    embedded += batch.length;
  }
  return embedded;
}

/** (Re)index a profile's base context: resume + notes (jobId = null). The JD is
 *  indexed separately per job by `indexJob`. */
export async function reindexProfile(
  profileId: string,
): Promise<{ chunks: number; embedded: number }> {
  const profile = profilesRepo.get(profileId);
  if (!profile) throw new Error('Profile not found');

  // Clear only the base (non-job) chunks for this profile (embeddings cascade).
  // This ALWAYS runs, so removing a resume cleans up its chunks even with no key.
  db()
    .delete(schema.chunks)
    .where(and(eq(schema.chunks.profileId, profileId), isNull(schema.chunks.jobId)))
    .run();
  // Without a key we can't embed, so there's nothing to (re)index — but the stale
  // chunks above are already gone.
  if (!apiKeyStore.isPresent()) return { chunks: 0, embedded: 0 };

  const sources: { type: 'resume' | 'note'; text: string }[] = [];
  if (profile.resumeText) sources.push({ type: 'resume', text: profile.resumeText });
  const notes = db().select().from(schema.notes).where(eq(schema.notes.profileId, profileId)).all();
  for (const n of notes) sources.push({ type: 'note', text: n.content });

  const rows: { id: string; content: string }[] = [];
  for (const src of sources) {
    for (const c of chunkText(src.text)) {
      const id = crypto.randomUUID();
      db()
        .insert(schema.chunks)
        .values({
          id,
          profileId,
          jobId: null,
          sourceType: src.type,
          ord: c.ord,
          content: c.content,
          tokenCount: Math.ceil(c.content.length / 4),
        })
        .run();
      rows.push({ id, content: c.content });
    }
  }
  return { chunks: rows.length, embedded: await embedChunks(rows) };
}

/** (Re)index a single job's context (jobId set): its JD plus any company research
 *  scraped from the company website. Both are scoped to the job. */
export async function indexJob(jobId: string): Promise<{ chunks: number; embedded: number }> {
  const job = db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) throw new Error('Job not found');

  // Always clear this job's chunks first (embeddings cascade), so removing a JD or
  // company research cleans up even with no key.
  db().delete(schema.chunks).where(eq(schema.chunks.jobId, jobId)).run();
  if (!apiKeyStore.isPresent()) return { chunks: 0, embedded: 0 };

  const sources: { type: 'jd' | 'company'; text: string }[] = [];
  if (job.jdText) sources.push({ type: 'jd', text: job.jdText });
  if (job.companyResearch) sources.push({ type: 'company', text: job.companyResearch });
  if (sources.length === 0) return { chunks: 0, embedded: 0 };

  const rows: { id: string; content: string }[] = [];
  for (const src of sources) {
    for (const c of chunkText(src.text)) {
      const id = crypto.randomUUID();
      db()
        .insert(schema.chunks)
        .values({
          id,
          profileId: job.profileId,
          jobId,
          sourceType: src.type,
          ord: c.ord,
          content: c.content,
          tokenCount: Math.ceil(c.content.length / 4),
        })
        .run();
      rows.push({ id, content: c.content });
    }
  }
  return { chunks: rows.length, embedded: await embedChunks(rows) };
}
