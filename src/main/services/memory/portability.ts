import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../../db';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { providerFor } from '../../providers/registry';
import { bufferToVector, vectorToBuffer } from '../rag/vectorMath';
import { checkSensitive } from './sensitiveFilter';
import { normalize } from './extractor';
import type { MemoryCategory } from '@shared/types';

/** The running app's version, without importing electron into the test path —
 *  the export is metadata-only, so an unknown version is not an error. */
function appVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as typeof import('electron')).app.getVersion();
  } catch {
    return 'unknown';
  }
}

/**
 * Memory portability — the user's memory is theirs to take with them.
 *
 * Deliberate properties:
 *  - **Plain JSON, not an opaque blob.** The file is the most sensitive thing
 *    the app produces, so it must be *inspectable*: the user can open it,
 *    read every line, edit it, and diff it. An encrypted container would hide
 *    exactly what they most need to verify. The UI says plainly what it
 *    contains; where it then gets stored is the user's decision, not ours.
 *  - **Never contains credentials or settings.** Memories and the labels
 *    needed to place them again — nothing else. The API key lives in the OS
 *    keychain and has no representation here.
 *  - **A snapshot of what is CURRENTLY true**, not the revision history:
 *    superseded rows are historical and their ids would be meaningless in
 *    another database. Rejected rows are excluded too — the user said no.
 *  - **Import merges, never replaces.** Nothing existing is deleted, and the
 *    sensitive filter runs over every incoming item, because a hand-edited
 *    file is untrusted input like any other.
 */

export const MEMORY_EXPORT_FORMAT = 'braincue.memory';
export const MEMORY_EXPORT_VERSION = 1;

const zCategory = z.enum([
  'preference',
  'person',
  'project',
  'goal',
  'decision',
  'fact',
  'workflow',
  'custom',
]);

const zExportedMemory = z.object({
  content: z.string().min(1).max(4000),
  category: zCategory,
  /** The Space's TITLE, not its id — ids are meaningless in another database.
   *  null = global to the profile. */
  scope: z.string().nullable().default(null),
  factKey: z.string().max(80).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  importance: z.number().min(0).max(1).default(0.5),
  status: z.enum(['pending', 'approved', 'archived']).default('pending'),
  sourceKind: z.enum(['extracted', 'authored', 'imported', 'derived']).default('imported'),
  validFrom: z.number().nullable().default(null),
  expiresAt: z.number().nullable().default(null),
  createdAt: z.number().nullable().default(null),
  /** base64 float32 — only usable when the file's embedding identity matches
   *  this install's. Absent for rows that were never embedded. */
  vector: z.string().nullable().default(null),
});

export const memoryExportSchema = z.object({
  format: z.literal(MEMORY_EXPORT_FORMAT),
  version: z.number().int().min(1).max(MEMORY_EXPORT_VERSION),
  exportedAt: z.number(),
  app: z.object({ name: z.string(), version: z.string() }).optional(),
  profile: z.object({ id: z.string(), name: z.string() }).optional(),
  embedding: z
    .object({ provider: z.string(), model: z.string(), dim: z.number() })
    .nullable()
    .default(null),
  memories: z.array(zExportedMemory).max(100_000),
});

export type MemoryExport = z.infer<typeof memoryExportSchema>;

/** Build the export payload for one profile. Pure read — no side effects. */
export function buildMemoryExport(profileId: string): MemoryExport {
  const profile = profilesRepo.get(profileId);
  if (!profile) throw new Error('Profile not found');

  const rows = db()
    .select()
    .from(schema.memories)
    .where(and(eq(schema.memories.profileId, profileId), isNull(schema.memories.supersededBy)))
    .all()
    .filter((r) => r.status !== 'rejected');

  // packId → Space title, so the scope survives the trip to another database.
  const titleFor = new Map<string, string>();
  for (const r of rows) {
    if (r.packId && !titleFor.has(r.packId)) {
      const pack = contextPacksRepo.get(r.packId);
      if (pack) titleFor.set(r.packId, pack.title);
    }
  }

  // The identity of the vectors in this file — an import can only reuse them
  // when its own embedding provider/model/dim agree.
  let embedding: MemoryExport['embedding'] = null;
  const embedded = rows.find((r) => r.embedVector && r.embedProvider && r.embedModel);
  if (embedded) {
    embedding = {
      provider: embedded.embedProvider as string,
      model: embedded.embedModel as string,
      dim: embedded.embedDim as number,
    };
  }

  return {
    format: MEMORY_EXPORT_FORMAT,
    version: MEMORY_EXPORT_VERSION,
    exportedAt: Date.now(),
    app: { name: 'BrainCue', version: appVersion() },
    profile: { id: profile.id, name: profile.name },
    embedding,
    memories: rows.map((r) => ({
      content: r.content,
      category: r.category as MemoryCategory,
      scope: r.packId ? (titleFor.get(r.packId) ?? null) : null,
      factKey: r.factKey,
      confidence: r.confidence,
      importance: r.importance,
      status: r.status as 'pending' | 'approved' | 'archived',
      sourceKind: r.sourceKind as 'extracted' | 'authored' | 'imported' | 'derived',
      validFrom: r.validFrom,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      vector:
        r.embedVector && embedding && r.embedProvider === embedding.provider
          ? (r.embedVector as Buffer).toString('base64')
          : null,
    })),
  };
}

export interface ImportSummary {
  imported: number;
  /** Already present (same normalized content, same scope) — left alone. */
  duplicates: number;
  /** Rejected by the sensitive filter. Never stored, in either mode. */
  blocked: number;
  /** Facts whose current value this import replaced (restore mode only). */
  superseded: number;
  /** Approved rows whose vectors had to be recomputed (identity mismatch). */
  reEmbedded: number;
  /** Scopes named in the file with no matching Space here — imported as
   *  profile-global rather than dangling. */
  unmatchedScopes: string[];
}

/**
 * Merge an export file into a profile's memory.
 *
 * `mode: 'review'` (default) lands everything as `pending`, so a file from
 * anywhere is reviewed before it can ground an answer. `mode: 'restore'`
 * preserves the exported statuses — for the user's own backup, where forcing
 * re-approval of hundreds of items would push them to rubber-stamp the lot.
 * The sensitive filter runs in BOTH modes: a hand-edited file is untrusted
 * input regardless of where it claims to come from.
 */
export async function importMemories(
  profileId: string,
  payload: unknown,
  mode: 'review' | 'restore' = 'review',
): Promise<ImportSummary> {
  const parsed = memoryExportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('That does not look like a BrainCue memory export.');
  }
  const file = parsed.data;
  if (!profilesRepo.get(profileId)) throw new Error('Profile not found');

  const summary: ImportSummary = {
    imported: 0,
    duplicates: 0,
    blocked: 0,
    superseded: 0,
    reEmbedded: 0,
    unmatchedScopes: [],
  };

  // Space titles → ids in THIS database. An unmatched scope becomes global:
  // a memory that is slightly too visible is recoverable, a dangling foreign
  // key is not.
  const packs = contextPacksRepo.list(profileId);
  const packIdFor = new Map(packs.map((p) => [p.title.trim().toLowerCase(), p.id]));

  const identity = providerFor('embedding').identity();
  const vectorsUsable =
    file.embedding != null &&
    file.embedding.provider === identity.provider &&
    file.embedding.model === identity.model &&
    file.embedding.dim === identity.dim;

  // Existing content fingerprints per scope, so re-importing the same file
  // twice is a no-op rather than a duplication.
  const existing = new Set(
    memoriesRepo
      .list({ profileId })
      .map((m) => `${m.packId ?? ''}::${normalize(m.content)}`),
  );

  for (const item of file.memories) {
    if (checkSensitive(item.content).sensitive) {
      summary.blocked += 1;
      continue;
    }

    let packId: string | null = null;
    if (item.scope) {
      const found = packIdFor.get(item.scope.trim().toLowerCase());
      if (found) packId = found;
      else if (!summary.unmatchedScopes.includes(item.scope)) {
        summary.unmatchedScopes.push(item.scope);
      }
    }

    const fingerprint = `${packId ?? ''}::${normalize(item.content)}`;
    if (existing.has(fingerprint)) {
      summary.duplicates += 1;
      continue;
    }

    const restoring = mode === 'restore' && item.status === 'approved';
    const id = memoriesRepo.insertCandidate({
      profileId,
      packId,
      category: item.category,
      content: item.content,
      confidence: item.confidence,
      importance: item.importance,
      sourceRefs: [{ type: 'import', id: String(file.exportedAt) }],
      factKey: item.factKey,
      sourceKind: 'imported',
    });
    existing.add(fingerprint);
    summary.imported += 1;

    if (!restoring) continue; // review mode: it stays pending, no embedding yet

    // Restore mode: bring the row back as approved, reusing the exported
    // vector when the embedding space agrees and recomputing when it doesn't.
    let vector: Buffer;
    if (vectorsUsable && item.vector) {
      vector = Buffer.from(item.vector, 'base64');
    } else {
      vector = vectorToBuffer(await providerFor('embedding').embedOne(item.content));
      summary.reEmbedded += 1;
    }

    const previous = item.factKey
      ? memoriesRepo.currentByFactKey(profileId, packId, item.factKey)
      : null;

    memoriesRepo.approve(id, {
      content: item.content,
      category: item.category,
      packId,
      embedding: { provider: identity.provider, model: identity.model, dim: identity.dim, vector },
    });

    // The M1 invariant holds across imports too: one current row per fact.
    if (previous && previous.id !== id) {
      memoriesRepo.supersede(previous.id, id);
      memoriesRepo.setRevision(id, memoriesRepo.nextRevision(previous));
      summary.superseded += 1;
    }
  }

  return summary;
}

/** Sanity helper for tests + the import preview: how many items a file holds
 *  and whether its vectors are reusable here, without writing anything. */
export function inspectMemoryExport(payload: unknown): {
  valid: boolean;
  count: number;
  vectorsUsable: boolean;
  exportedAt: number | null;
} {
  const parsed = memoryExportSchema.safeParse(payload);
  if (!parsed.success) return { valid: false, count: 0, vectorsUsable: false, exportedAt: null };
  const identity = providerFor('embedding').identity();
  const e = parsed.data.embedding;
  return {
    valid: true,
    count: parsed.data.memories.length,
    vectorsUsable:
      e != null && e.provider === identity.provider && e.model === identity.model && e.dim === identity.dim,
    exportedAt: parsed.data.exportedAt,
  };
}

/** Decode a stored vector — used by tests to assert a restored row is
 *  searchable with the same numbers it left with. */
export function decodeVector(b64: string): Float32Array {
  return bufferToVector(Buffer.from(b64, 'base64'));
}
