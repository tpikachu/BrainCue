import { describe, expect, it, vi } from 'vitest';

// effortFor consults these only for models outside the catalog / non-live tasks.
vi.mock('../services/openai/models', () => ({ isReasoningModel: () => false, reasoningEffort: () => 'low' }));

import { effortFor } from './effort';
import { MODEL_CATALOG } from '@shared/providers';
import { liveTaskEffort } from '@shared/modelPolicy';

/** The latency record's effort (liveTaskEffort) must be exactly what the
 *  answer request sends (effortFor) — for every model in the catalog. */
describe('liveTaskEffort mirrors effortFor for the live answer task', () => {
  it.each(MODEL_CATALOG.map((m) => [m.provider, m.id] as const))('%s/%s', (provider, id) => {
    expect(liveTaskEffort(provider, id)).toBe(effortFor('answer', provider, id) ?? 'not-sent');
  });

  it('a model outside the catalog is named as such, never guessed', () => {
    expect(liveTaskEffort('openai', 'some-future-model')).toBe('not-in-catalog');
  });
});
