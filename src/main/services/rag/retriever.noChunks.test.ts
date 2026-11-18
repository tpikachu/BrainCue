import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retrieval paths:
 *  - an empty Space never pays the embedding round trip;
 *  - with comparable vectors, it embeds and searches (identity-filtered);
 *  - with NO embedder (no OpenAI key) or a failing one, chunks are ranked
 *    lexically (BM25) — never dropped, never compared across spaces;
 *  - chunks embedded under another model are ranked lexically too.
 */
type Row = { id: string; sourceType: string; content: string; embedded: { provider: string; model: string; dim: number } | null };
const h = vi.hoisted(() => ({
  scope: [] as Row[],
  embedCalls: 0,
  searchCalls: 0,
  searchIdentity: undefined as unknown,
  embedFails: false,
  identity: { provider: 'openai', model: 'text-embedding-3-small', dim: 3 },
}));

vi.mock('./vectorStore', () => ({
  sqliteVectorStore: {
    scope: () => h.scope,
    search: (a: { identity?: unknown }) => {
      h.searchCalls++;
      h.searchIdentity = a.identity;
      return h.scope
        .filter((r) => r.embedded?.model === h.identity.model)
        .map((r, i) => ({ id: r.id, sourceType: r.sourceType, content: r.content, score: 0.8 - i * 0.05 }));
    },
    topStory: () => null,
  },
}));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    identity: () => h.identity,
    embedOne: async () => {
      h.embedCalls++;
      if (h.embedFails) throw new Error('OpenAI needs an API key');
      return new Float32Array([1, 0, 0]);
    },
  }),
}));

import { retrieve } from './retriever';

const emb = (model = 'text-embedding-3-small') => ({ provider: 'openai', model, dim: 3 });

beforeEach(() => {
  h.scope = [];
  h.embedCalls = 0;
  h.searchCalls = 0;
  h.searchIdentity = undefined;
  h.embedFails = false;
});

describe('retrieve — empty Space', () => {
  it('returns [] without embedding when the profile has no chunks', async () => {
    expect(await retrieve('p1', 'what is our budget?', 5, null)).toEqual([]);
    expect(h.embedCalls).toBe(0);
    expect(h.searchCalls).toBe(0);
  });

  it('embeds and searches — filtered to the current embedding space — when vectors exist', async () => {
    h.scope = [{ id: 'r1', sourceType: 'resume', content: 'Budget owner for platform', embedded: emb() }];
    await retrieve('p1', 'what is our budget?', 5, null, { storyCue: false });
    expect(h.embedCalls).toBe(1);
    expect(h.searchCalls).toBe(1);
    expect(h.searchIdentity).toEqual(h.identity);
  });
});

describe('retrieve — without a usable embedder', () => {
  const corpus: Row[] = [
    { id: 'r1', sourceType: 'resume', content: 'Led the payments ledger migration from MySQL to Postgres at Stripe.', embedded: null },
    { id: 'r2', sourceType: 'resume', content: 'Mentored four junior engineers on the search team.', embedded: null },
    { id: 'j1', sourceType: 'jd', content: 'Requires experience migrating large databases and owning on-call.', embedded: null },
  ];

  it('no vectors at all (no OpenAI key ever) → BM25 ranks the chunks; no embedding call', async () => {
    h.scope = corpus;
    const out = await retrieve('p1', 'Tell me about the database migration you led', 5, null, { storyCue: false });
    expect(h.embedCalls).toBe(0);
    expect(out[0].id).toBe('r1');
    expect(out.map((c) => c.id)).toContain('j1'); // the JD side is represented
    expect(out.every((c) => c.score > 0 && c.score <= 1)).toBe(true);
  });

  it('the embedding call fails (key removed, network) → the same lexical ranking', async () => {
    h.scope = corpus.map((r) => ({ ...r, embedded: emb() }));
    h.embedFails = true;
    const out = await retrieve('p1', 'database migration', 5, null, { storyCue: false });
    expect(h.searchCalls).toBe(0);
    expect(out[0].id).toBe('r1');
  });

  it('chunks from ANOTHER embedding model are never vector-compared — they rank lexically', async () => {
    h.scope = [
      { id: 'old', sourceType: 'resume', content: 'Led the database migration to Postgres.', embedded: emb('text-embedding-ada-002') },
      { id: 'new', sourceType: 'jd', content: 'Owns on-call rotations.', embedded: emb() },
    ];
    const out = await retrieve('p1', 'database migration', 5, null, { storyCue: false });
    expect(h.searchCalls).toBe(1); // vector search for the comparable chunk only
    expect(out.map((c) => c.id)).toContain('old'); // present via the lexical pool
  });

  it('a mixed index: unembedded chunks (e.g. a JD added without a key) still compete', async () => {
    h.scope = [
      { id: 'r1', sourceType: 'resume', content: 'Led the payments migration.', embedded: emb() },
      { id: 'j1', sourceType: 'jd', content: 'Experience migrating payments systems required.', embedded: null },
    ];
    const out = await retrieve('p1', 'payments migration', 5, null, { storyCue: false });
    expect(out.map((c) => c.id).sort()).toEqual(['j1', 'r1']);
  });
});
