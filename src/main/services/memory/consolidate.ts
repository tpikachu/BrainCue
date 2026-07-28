import { memoriesRepo } from '../../db/repositories/memories.repo';
import { entitiesRepo } from '../../db/repositories/entities.repo';
import { checkSensitive } from './sensitiveFilter';
import type { EntityKind, MemoryCategory, MemoryItem, MemorySourceKind } from '@shared/types';

/**
 * The consolidation stage (docs/14-MEMORY.md §3.4) — the one place a proposed
 * memory becomes a stored candidate.
 *
 * Every producer goes through here: post-session extraction, document ingest,
 * and anything added later. That is deliberate. Invariants 1 and 2 say the
 * sensitive filter runs before persistence on *every* path and nothing is
 * remembered without review; a shared function makes that structural rather
 * than a rule each new caller has to remember.
 *
 * Consolidation compares each candidate against what is already known and
 * drops the ones that say nothing new. Previously this only happened for
 * candidates carrying a `factKey`, so a plain sentence could be re-proposed
 * after every session forever — and re-proposing something the user already
 * rejected quietly ignores their answer. Matching is on normalized content,
 * within the scope the candidate would land in.
 */

export const MEMORY_CONFIDENCE_FLOOR = 0.6;

/** Normalized for comparison: case, punctuation, and spacing collapsed away so
 *  "We ship on May 3rd." and "we ship on may 3rd" are recognised as the same
 *  claim and the second one doesn't create a duplicate row. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CandidateDraft {
  category: MemoryCategory;
  content: string;
  /** null = global to the profile; a string = scoped to that Space. */
  packId: string | null;
  confidence: number;
  importance: number;
  factKey?: string | null;
  entities?: { name: string; kind: EntityKind }[];
}

export interface ConsolidationResult {
  /** Ids of the rows written, all `pending`. */
  saved: string[];
  /** Already known in this scope — dropped, and re-confirmed if approved. */
  duplicates: number;
  /** Rejected by the sensitive filter. Never written, never counted as saved. */
  blocked: number;
  belowFloor: number;
}

/**
 * Persist candidates as pending memories, dropping anything already known,
 * sensitive, or below the confidence floor. Returns what happened to each so
 * the caller can report it honestly instead of just "n saved".
 */
export function persistCandidates(opts: {
  profileId: string;
  candidates: CandidateDraft[];
  sourceRefs: { type: string; id: string }[];
  sourceKind: MemorySourceKind;
  confidenceFloor?: number;
  now?: number;
}): ConsolidationResult {
  const floor = opts.confidenceFloor ?? MEMORY_CONFIDENCE_FLOOR;
  const now = opts.now ?? Date.now();
  const result: ConsolidationResult = { saved: [], duplicates: 0, blocked: 0, belowFloor: 0 };

  // Every status counts as "known": approved and pending are obvious, and a
  // rejected row means the user said no — silently proposing it again is the
  // one behaviour guaranteed to make the review queue feel broken.
  const known = new Map<string, MemoryItem[]>();
  for (const m of memoriesRepo.list({ profileId: opts.profileId })) {
    const key = normalize(m.content);
    const bucket = known.get(key);
    if (bucket) bucket.push(m);
    else known.set(key, [m]);
  }
  // A global memory is visible inside every Space, so it deduplicates a
  // Space-scoped candidate; a memory belonging to a *different* Space does not.
  const seenIn = (key: string, packId: string | null): MemoryItem | null =>
    known.get(key)?.find((m) => m.packId == null || m.packId === packId) ?? null;

  for (const c of opts.candidates) {
    if (c.confidence < floor) {
      result.belowFloor += 1;
      continue;
    }
    if (checkSensitive(c.content).sensitive) {
      result.blocked += 1; // hard privacy gate — never stored, on any path
      continue;
    }
    const key = normalize(c.content);
    if (!key) continue;

    const duplicate = seenIn(key, c.packId);
    if (duplicate) {
      result.duplicates += 1;
      // Re-confirmed rather than re-stored: seeing a fact again is evidence it
      // still matters, which is exactly what recency is for.
      if (duplicate.status === 'approved') memoriesRepo.markUsed([duplicate.id], now);
      continue;
    }

    const id = memoriesRepo.insertCandidate({
      profileId: opts.profileId,
      packId: c.packId,
      category: c.category,
      content: c.content,
      confidence: c.confidence,
      importance: c.importance,
      sourceRefs: opts.sourceRefs,
      factKey: c.factKey ?? null,
      sourceKind: opts.sourceKind,
    });
    linkEntities(opts.profileId, id, c.entities ?? []);
    result.saved.push(id);

    // Fold the new row in so the rest of THIS batch dedupes against it too —
    // a long document repeats itself, and each repeat would otherwise become
    // its own candidate.
    const row = memoriesRepo.get(id);
    if (row) known.set(key, [...(known.get(key) ?? []), row]);
  }
  return result;
}

/**
 * Link what a memory is ABOUT (docs/14-MEMORY.md §3.2). An unrecognised
 * spelling becomes its own entity rather than being guessed into an existing
 * one — over-splitting is recoverable in one click, over-merging is not.
 */
export function linkEntities(
  profileId: string,
  memoryId: string,
  entities: { name: string; kind: EntityKind }[],
): void {
  for (const e of entities) {
    try {
      const entity = entitiesRepo.upsertByName({ profileId, name: e.name, kind: e.kind });
      entitiesRepo.link(memoryId, entity.id, 'mentioned');
    } catch {
      // An entity that fails to resolve must never cost us the memory.
    }
  }
}
