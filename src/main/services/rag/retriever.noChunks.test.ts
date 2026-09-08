import { describe, expect, it, vi } from 'vitest';

/** A Space with nothing indexed must not pay the embedding round trip: the
 *  retriever probes the store first and returns [] without calling the provider. */
const h = vi.hoisted(() => ({ hasAny: false, embedCalls: 0, searchCalls: 0 }));

vi.mock('./vectorStore', () => ({
  sqliteVectorStore: {
    hasAny: () => h.hasAny,
    search: () => {
      h.searchCalls++;
      return [];
    },
    topStory: () => null,
  },
}));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    embedOne: async () => {
      h.embedCalls++;
      return new Float32Array([1, 0, 0]);
    },
  }),
}));

import { retrieve } from './retriever';

describe('retrieve — empty Space', () => {
  it('returns [] without embedding when the profile has no chunks', async () => {
    h.hasAny = false;
    expect(await retrieve('p1', 'what is our budget?', 5, null)).toEqual([]);
    expect(h.embedCalls).toBe(0);
    expect(h.searchCalls).toBe(0);
  });

  it('embeds and searches as before when there is something to rank', async () => {
    h.hasAny = true;
    await retrieve('p1', 'what is our budget?', 5, null, { storyCue: false });
    expect(h.embedCalls).toBe(1);
    expect(h.searchCalls).toBe(1);
  });
});
