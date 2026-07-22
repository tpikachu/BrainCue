import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
}));

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return {
    schema,
    db: () => h.db,
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { assertEmbeddingCompatibility } from './embeddingIdentity';
import { EmbeddingIdentityMismatchError } from '../../providers/errors';

const OPENAI_SMALL = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 };

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});

describe('embedding identity guard (no mixed vector spaces)', () => {
  it('an empty index accepts any identity', () => {
    expect(() => assertEmbeddingCompatibility(OPENAI_SMALL)).not.toThrow();
  });

  it('matching identity writes are allowed; a different model or provider is refused', () => {
    h.db.insert(schema.profiles).values({ id: 'pg1', name: 'Guard' }).run();
    h.db
      .insert(schema.chunks)
      .values({ id: 'cg1', profileId: 'pg1', sourceType: 'resume', content: 'x' })
      .run();
    h.db
      .insert(schema.embeddings)
      .values({
        id: 'eg1',
        chunkId: 'cg1',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dim: 1536,
        vector: Buffer.from(new Float32Array([1, 2]).buffer),
      })
      .run();

    expect(() => assertEmbeddingCompatibility(OPENAI_SMALL)).not.toThrow();

    expect(() =>
      assertEmbeddingCompatibility({ ...OPENAI_SMALL, model: 'text-embedding-3-large' }),
    ).toThrowError(EmbeddingIdentityMismatchError);
    // The message tells the user exactly what to do about it.
    expect(() =>
      assertEmbeddingCompatibility({ provider: 'acme', model: 'embed-9', dim: 512 }),
    ).toThrow(/Re-index/i);
  });
});
