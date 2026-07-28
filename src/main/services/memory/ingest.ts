import { z } from 'zod';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { chunkText } from '../rag/chunker';
import { persistCandidates } from './consolidate';

/**
 * Document ingest — "things to know about me" (docs/14-MEMORY.md §3.5).
 *
 * A transcript is something the app overheard, so extraction from it is
 * deliberately timid. A document is something the user *handed over*: a bio, a
 * brag document, meeting notes, an account brief. The intent is explicit, so
 * this path reads the whole thing rather than capping at five facts — but it
 * changes nothing else. Candidates land `pending`, the sensitive filter still
 * rejects before persistence, and consolidation still drops anything already
 * known. Ingest is a faster way to fill the review queue, never a way around
 * it (invariant 2).
 *
 * The text is extracted from the file locally; only the extracted text goes to
 * the model, which is the same trade the rest of the app makes.
 */

/** Big enough that a fact and its context usually land in one window, small
 *  enough that the model still reads carefully. */
export const INGEST_CHUNK_CHARS = 2400;
/** A hard ceiling on the work one ingest can start. Someone will eventually
 *  drop a 300-page PDF in here; the honest response is to read the beginning
 *  and SAY so, not to quietly spend an hour of API calls. */
export const INGEST_MAX_CHUNKS = 40;
const MAX_PER_CHUNK = 8;

/**
 * Split a document into excerpt-sized windows.
 *
 * `chunkText` packs paragraphs and keeps an over-long one whole — correct for
 * the résumés and job descriptions it was written for, wrong here: extracted
 * PDF text frequently has no blank lines at all and arrives as a single
 * 90,000-character "paragraph", which would become one enormous model call.
 * Anything still over the window is cut on a sentence boundary where there is
 * one nearby, and bluntly where there isn't.
 */
export function toWindows(text: string): string[] {
  const out: string[] = [];
  for (const chunk of chunkText(text, INGEST_CHUNK_CHARS)) {
    let rest = chunk.content;
    while (rest.length > INGEST_CHUNK_CHARS) {
      const period = rest.lastIndexOf('. ', INGEST_CHUNK_CHARS);
      const cut = period > INGEST_CHUNK_CHARS / 2 ? period + 1 : INGEST_CHUNK_CHARS;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out;
}

export const ingestSchema = z.object({
  candidates: z
    .array(
      z.object({
        category: z.enum([
          'preference',
          'person',
          'project',
          'goal',
          'decision',
          'fact',
          'workflow',
          'custom',
        ]),
        content: z.string().min(8).max(400),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1).default(0.5),
        factKey: z
          .string()
          .regex(/^[a-z0-9]+:[a-z0-9-]+\/[a-z0-9-]+$/)
          .max(80)
          .nullish(),
        entities: z
          .array(
            z.object({
              name: z.string().min(2).max(80),
              kind: z.enum(['person', 'org', 'project', 'product', 'place', 'topic']),
            }),
          )
          .max(6)
          .default([]),
      }),
    )
    .max(MAX_PER_CHUNK)
    .default([]),
});

export interface IngestResult {
  /** Chunks the document was split into, and how many were actually read. */
  chunks: number;
  chunksRead: number;
  /** Chunks whose model call failed or returned an unusable shape. Reported,
   *  never swallowed — a partial read the user thinks was complete is worse
   *  than a visible failure. */
  chunksFailed: number;
  /** true when the document was longer than INGEST_MAX_CHARS and the tail was
   *  not read. */
  truncated: boolean;
  proposed: number;
  duplicates: number;
  blocked: number;
  belowFloor: number;
}

const SYSTEM = `You turn a document the user has given you into durable memory entries about them and their work. The user chose this document deliberately, so read it thoroughly — but write entries, not a summary.

Return STRICT JSON:
{"candidates": [{"category": "preference"|"person"|"project"|"goal"|"decision"|"fact"|"workflow"|"custom", "content": string, "confidence": 0..1, "importance": 0..1, "factKey": string|null, "entities": [{"name": string, "kind": "person"|"org"|"project"|"product"|"place"|"topic"}]}]}

RULES:
- Each "content" is ONE self-contained sentence that still makes sense a year from now with the document long gone. Never write "as mentioned above" or "the company" — name it.
- At most ${MAX_PER_CHUNK} entries for this excerpt. Prefer the durable over the incidental: what someone would need to know to stand in for this person. Skip formatting, headings, boilerplate, and anything true only on the day it was written.
- Return {"candidates": []} for an excerpt that carries nothing durable. That is a normal answer, not a failure.
- NEVER include secrets, credentials, payment data, government IDs, health details, or sensitive personal attributes (religion, politics, orientation, immigration, criminal record) — not even paraphrased.
- "confidence" is how clearly THIS text states it. Inference from tone or implication scores low.

SET "factKey" ONLY for a fact that can have exactly ONE current value, so a later value replaces this one rather than sitting beside it. Format: "domain:subject/attribute", lowercase kebab — e.g. "project:atlas/launch-date", "person:sarah-chen/role", "profile:user/job-title". A wrong key silently retires a good memory, so when unsure, omit it.

LIST "entities" — the people, companies, projects, or products the entry is ABOUT (not every noun in it). Use the fullest name the document gives ("Sarah Chen", not "Sarah"); the store matches spellings itself. Omit generic references ("the client", "our team").`;

/**
 * Read a document into pending memory candidates. Throws on the conditions the
 * user can fix (consent off, Space opted out, empty document) because this is a
 * button they pressed — silence would look like a bug. Per-chunk model failures
 * are counted and reported rather than thrown: half a document is still worth
 * reviewing, as long as the count says so.
 */
export async function ingestDocument(opts: {
  profileId: string;
  packId: string | null;
  text: string;
  /** Filename or "Pasted text" — kept as the memory's provenance. */
  label: string;
}): Promise<IngestResult> {
  if (settingsRepo.get(SETTINGS_KEYS.memoryEnabled) !== '1') {
    throw new Error('Turn memory on before importing a document.');
  }
  if (opts.packId) {
    const pack = contextPacksRepo.get(opts.packId);
    if (pack && !pack.memoryEnabled) {
      throw new Error('This Space has memory turned off.');
    }
  }
  const text = opts.text.trim();
  if (text.length < 40) throw new Error('That document is too short to read anything from.');

  const all = toWindows(text);
  const truncated = all.length > INGEST_MAX_CHUNKS;
  const chunks = all.slice(0, INGEST_MAX_CHUNKS);

  const result: IngestResult = {
    chunks: chunks.length,
    chunksRead: 0,
    chunksFailed: 0,
    truncated,
    proposed: 0,
    duplicates: 0,
    blocked: 0,
    belowFloor: 0,
  };

  for (const [i, chunk] of chunks.entries()) {
    let parsed: z.infer<typeof ingestSchema>;
    try {
      const raw = await providerFor('chat').json<unknown>({
        task: 'parsing',
        system: SYSTEM,
        user: `Document: ${opts.label}\nExcerpt ${i + 1} of ${chunks.length}:\n${chunk}`,
        maxOutputTokens: 900,
      });
      const validated = ingestSchema.safeParse(raw);
      if (!validated.success) {
        result.chunksFailed += 1;
        continue; // an unusable shape is a failed chunk, never a partial guess
      }
      parsed = validated.data;
    } catch {
      result.chunksFailed += 1;
      continue;
    }
    result.chunksRead += 1;

    // Persist per chunk rather than at the end: consolidation then dedupes the
    // repetition a long document is full of, and a failure halfway through
    // leaves the user with everything read so far instead of nothing.
    const outcome = persistCandidates({
      profileId: opts.profileId,
      candidates: parsed.candidates.map((c) => ({
        category: c.category,
        content: c.content,
        packId: opts.packId,
        confidence: c.confidence,
        importance: c.importance,
        factKey: c.factKey ?? null,
        entities: c.entities,
      })),
      sourceRefs: [{ type: 'document', id: opts.label }],
      sourceKind: 'imported',
    });
    result.proposed += outcome.saved.length;
    result.duplicates += outcome.duplicates;
    result.blocked += outcome.blocked;
    result.belowFloor += outcome.belowFloor;
  }
  return result;
}
