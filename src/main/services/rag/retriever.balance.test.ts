import { describe, expect, it, vi } from 'vitest';

vi.mock('../../providers/registry', () => ({ providerFor: vi.fn() }));
vi.mock('./vectorStore', () => ({ sqliteVectorStore: {} }));

import { balanceSources } from './retriever';
import type { RetrievedChunk } from '@shared/types';

const c = (id: string, sourceType: RetrievedChunk['sourceType'], score: number): RetrievedChunk => ({
  id,
  sourceType,
  content: id,
  score,
});

describe('balanceSources — one source cannot crowd out the other', () => {
  it('a relevant JD chunk replaces the weakest résumé chunk when the top-k is all résumé', () => {
    const picked = [c('r1', 'resume', 0.62), c('r2', 'resume', 0.6), c('r3', 'resume', 0.58), c('r4', 'resume', 0.55), c('r5', 'resume', 0.5)];
    const ranked = [...picked, c('j1', 'jd', 0.48)];
    const out = balanceSources(picked, ranked);
    expect(out.map((x) => x.id)).toContain('j1');
    expect(out.map((x) => x.id)).not.toContain('r5');
    expect(out).toHaveLength(5);
  });

  it('a relevant résumé chunk joins a top-k that is all JD', () => {
    const picked = [c('j1', 'jd', 0.7), c('j2', 'jd', 0.68), c('j3', 'company', 0.6)];
    const ranked = [...picked, c('r1', 'resume', 0.5)];
    expect(balanceSources(picked, ranked).map((x) => x.id)).toContain('r1');
  });

  it('never forces in an irrelevant chunk', () => {
    const picked = [c('r1', 'resume', 0.8), c('r2', 'resume', 0.75), c('r3', 'resume', 0.7)];
    const ranked = [...picked, c('j1', 'jd', 0.2)]; // < 60% of the best match
    expect(balanceSources(picked, ranked).map((x) => x.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('leaves an already-balanced top-k alone', () => {
    const picked = [c('r1', 'resume', 0.8), c('j1', 'jd', 0.7), c('r2', 'resume', 0.6)];
    expect(balanceSources(picked, [...picked, c('j2', 'jd', 0.59)])).toEqual(picked);
  });
});
