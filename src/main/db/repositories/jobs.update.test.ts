import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `jobsRepo.update` copies an allow-list of fields onto the row. That is a
 * reasonable shape — it keeps `id`/`profileId`/`createdAt` unwritable — but it
 * fails SILENTLY: a field missing from the list is dropped and the function
 * still returns the row and reports success.
 *
 * It cost an afternoon exactly once. `tailoredResume` was added to the schema,
 * the type, the migration, the IPC handler and the UI, and the handler returned
 * `{ ok: true }` having written nothing — the model call ran, was paid for, and
 * its result went in the bin. Nothing failed, so nothing pointed anywhere.
 *
 * These tests make the next one fail loudly instead.
 */

const h = vi.hoisted(() => ({ db: null as unknown as import('../../test/dbHarness').TestDb }));

vi.mock('../index', async () => {
  const schema = await vi.importActual<typeof import('../schema')>('../schema');
  return {
    schema,
    db: () => {
      if (!h.db) throw new Error('test db not initialized');
      return h.db;
    },
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});

import * as schema from '../schema';
import { createTestDb } from '../../test/dbHarness';
import { jobsRepo } from './jobs.repo';

let seq = 0;

function seedSpace(): string {
  const pid = `ju-p${++seq}`;
  const id = `ju-j${++seq}`;
  h.db.insert(schema.profiles).values({ id: pid, name: 'Alex' }).run();
  h.db
    .insert(schema.contextPacks)
    .values({ id, profileId: pid, kind: 'job', title: 'Staff PM', jdText: 'Own the roadmap.' })
    .run();
  return id;
}

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});

describe('jobsRepo.update persists what it is given', () => {
  it('writes the tailored résumé — the field the allow-list dropped', () => {
    const id = seedSpace();
    const text = 'Alex Rivera — rewritten for the Staff PM role.';

    const returned = jobsRepo.update(id, { tailoredResume: text });

    // Both, deliberately: `update` returns `this.get(id)`, so a bug that wrote
    // nothing would still be caught here — but only if the row is re-read.
    expect(returned.tailoredResume).toBe(text);
    expect(jobsRepo.get(id)!.tailoredResume).toBe(text);
  });

  it('clears it with null, rather than treating null as "leave alone"', () => {
    const id = seedSpace();
    jobsRepo.update(id, { tailoredResume: 'something' });
    expect(jobsRepo.update(id, { tailoredResume: null }).tailoredResume).toBeNull();
  });

  it('leaves a field alone when the patch omits it', () => {
    const id = seedSpace();
    jobsRepo.update(id, { tailoredResume: 'keep me' });
    jobsRepo.update(id, { title: 'Renamed' });
    const row = jobsRepo.get(id)!;
    expect(row.title).toBe('Renamed');
    expect(row.tailoredResume).toBe('keep me'); // undefined ≠ null
  });

  /**
   * The guard proper: every writable column must be handled.
   *
   * Adding a column to `schema.ts` and forgetting `update` produces no error
   * anywhere — this is the only thing that notices. The exclusions are the
   * columns that are deliberately NOT patchable here, each for a stated
   * reason; adding to that list should take an argument.
   */
  it('handles every writable column on the Space', () => {
    const NOT_PATCHABLE = new Set([
      'id', // identity
      'profileId', // ownership — a Space never changes hands
      'createdAt',
      'updatedAt', // stamped by update() itself
      'memoryEnabled', // dedicated setter (setMemoryEnabled)
      'companionPrefs', // dedicated setter (setCompanionPrefs)
    ]);
    const columns = Object.keys(schema.contextPacks).filter(
      (k) => !k.startsWith('_') && !NOT_PATCHABLE.has(k),
    );
    expect(columns.length).toBeGreaterThan(5); // the introspection actually found columns

    const id = seedSpace();
    const unhandled: string[] = [];
    for (const col of columns) {
      // A string is a valid value for every text column here; the two json
      // columns take an object. Either way the assertion is only "did anything
      // at all land", which is what an allow-list miss gets wrong.
      const probe = col === 'parsedJd' || col === 'parsedCompany' ? ({ probe: true } as never) : `v-${col}`;
      jobsRepo.update(id, { [col]: probe } as never);
      const after = jobsRepo.get(id) as unknown as Record<string, unknown>;
      const landed = after[col];
      if (landed === null || landed === undefined) unhandled.push(col);
    }
    expect(
      unhandled,
      'these columns exist on the Space but jobsRepo.update silently ignores them',
    ).toEqual([]);
  });
});
