import { and, eq, isNull, ne } from 'drizzle-orm';
import { db, schema } from '../../db';
import { chunkText } from './chunker';
import { embed } from '../openai/embeddings';
import { sqliteVectorStore } from './vectorStore';
import { vectorToBuffer } from './vectorMath';
import { model } from '../openai/models';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { storiesRepo, storyInsertValues } from '../../db/repositories/stories.repo';
import { applicationsRepo } from '../../db/repositories/applications.repo';
import { apiKeyStore } from '../security/apiKey';
import type { Story, StoryDraft, StoryInput } from '@shared/types';

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

  // Clear only the base (non-job) resume/note chunks for this profile (embeddings
  // cascade). Excludes `story` chunks — those are managed separately by indexStories,
  // so re-saving a résumé doesn't wipe the curated story bank. ALWAYS runs, so
  // removing a resume cleans up its chunks even with no key.
  db()
    .delete(schema.chunks)
    .where(
      and(
        eq(schema.chunks.profileId, profileId),
        isNull(schema.chunks.packId),
        ne(schema.chunks.sourceType, 'story'),
      ),
    )
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
          packId: null,
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
  db().delete(schema.chunks).where(eq(schema.chunks.packId, jobId)).run();
  if (!apiKeyStore.isPresent()) return { chunks: 0, embedded: 0 };

  const sources: { type: 'jd' | 'company' | 'tailored'; text: string }[] = [];
  if (job.jdText) sources.push({ type: 'jd', text: job.jdText });
  if (job.companyResearch) sources.push({ type: 'company', text: job.companyResearch });
  // An application-owned job also indexes its TAILORED resume (job-scoped), which
  // replaces the base resume in retrieval for this job's sessions (see vectorStore).
  // Indexed here — inside indexJob's single clear-and-reinsert pass — so jd/company/
  // tailored chunks never wipe each other.
  const app = applicationsRepo.getByJobId(jobId);
  if (app?.tailoredResume) sources.push({ type: 'tailored', text: app.tailoredResume });
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
          packId: jobId,
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

/** Flatten a STAR story into one embeddable/retrievable text blob (kept atomic —
 *  one chunk per story so a retrieved citation maps to a whole story). */
function storyToText(s: Pick<Story, 'title' | 'situation' | 'task' | 'action' | 'result'>): string {
  return [
    s.title,
    `Situation: ${s.situation}`,
    `Task: ${s.task}`,
    `Action: ${s.action}`,
    `Result: ${s.result}`,
  ]
    .filter((l) => l.trim())
    .join('\n');
}

/** WHERE matching a profile's `story` chunks (jobId is null for stories). */
const storyChunksOf = (profileId: string) =>
  and(eq(schema.chunks.profileId, profileId), eq(schema.chunks.sourceType, 'story'));

/** Pure insert-values builders (no transaction type needed), so the chunk + its
 *  embedding can be written inside a sync better-sqlite3 transaction. */
function storyChunkValues(profileId: string, ord: number, content: string) {
  return {
    id: crypto.randomUUID(),
    profileId,
    packId: null as string | null,
    sourceType: 'story' as const,
    ord,
    content,
    tokenCount: Math.ceil(content.length / 4),
  };
}
function embeddingValues(chunkId: string, vector: Float32Array) {
  return {
    id: crypto.randomUUID(),
    chunkId,
    model: model('embedding'),
    dim: vector.length,
    vector: vectorToBuffer(vector),
  };
}

/** (Re)index a profile's STAR stories as `story` chunks (jobId = null) so they can
 *  ground live answers via the same retriever. Call after any story mutation.
 *  Embeds BEFORE mutating, so a failed embedding leaves the existing index intact
 *  (no half-written chunks-without-embeddings). */
export async function indexStories(
  profileId: string,
): Promise<{ chunks: number; embedded: number }> {
  // No key → just clear story chunks (nothing to embed) so deleting stories still
  // cleans up their chunks. ALWAYS runs.
  if (!apiKeyStore.isPresent()) {
    db().delete(schema.chunks).where(storyChunksOf(profileId)).run();
    return { chunks: 0, embedded: 0 };
  }

  const stories = storiesRepo.list(profileId);
  const contents = stories.map((s) => storyToText(s));
  // Network FIRST: if this throws, no DB mutation happens below.
  const vectors = contents.length ? await embed(contents) : [];

  db().transaction((tx) => {
    tx.delete(schema.chunks).where(storyChunksOf(profileId)).run();
    contents.forEach((content, i) => {
      const cv = storyChunkValues(profileId, i, content);
      tx.insert(schema.chunks).values(cv).run();
      if (vectors[i]) tx.insert(schema.embeddings).values(embeddingValues(cv.id, vectors[i])).run();
    });
  });
  return { chunks: stories.length, embedded: vectors.filter(Boolean).length };
}

/** Atomically replace a profile's ENTIRE story bank (rows + `story` chunks +
 *  embeddings) from freshly-extracted drafts. Embeds BEFORE any destructive write,
 *  so a failed embedding (or a generation that yielded nothing) leaves the prior
 *  bank fully intact. Used by the regenerate path. */
export async function replaceStories(profileId: string, drafts: StoryDraft[]): Promise<Story[]> {
  const contents = drafts.map((d) => storyToText(d));
  // Network FIRST. A rejection here means nothing is deleted or inserted.
  const vectors = apiKeyStore.isPresent() && contents.length ? await embed(contents) : [];

  db().transaction((tx) => {
    tx.delete(schema.stories).where(eq(schema.stories.profileId, profileId)).run();
    tx.delete(schema.chunks).where(storyChunksOf(profileId)).run();
    drafts.forEach((d, i) => {
      const input: StoryInput = { profileId, ...d };
      tx.insert(schema.stories).values(storyInsertValues(crypto.randomUUID(), input)).run();
      const cv = storyChunkValues(profileId, i, contents[i]);
      tx.insert(schema.chunks).values(cv).run();
      if (vectors[i]) tx.insert(schema.embeddings).values(embeddingValues(cv.id, vectors[i])).run();
    });
  });
  return storiesRepo.list(profileId);
}
