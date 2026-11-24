import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { text: string; signal?: AbortSignal }[],
  delay: 100,
  fail: false,
  model: 'text-embedding-3-small',
}));

vi.mock('../../providers/registry', () => ({
  providerFor: () => ({
    identity: () => ({ provider: 'openai', model: h.model, dim: 3 }),
    embedOne: (text: string, opts?: { signal?: AbortSignal }) => {
      h.calls.push({ text, signal: opts?.signal });
      return new Promise<Float32Array>((resolve, reject) => {
        const t = setTimeout(() => (h.fail ? reject(new Error('503')) : resolve(Float32Array.from([1, 0, 0]))), h.delay);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    },
  }),
}));

import { EmbedDeadlineError, LIVE_EMBED_DEADLINE_MS, clearLiveEmbedCache, embedLiveQuery } from './liveEmbed';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  h.calls.length = 0;
  h.delay = 100;
  h.fail = false;
  h.model = 'text-embedding-3-small';
  clearLiveEmbedCache();
});
afterEach(() => vi.useRealTimers());

describe('embedLiveQuery — the live answer path’s query embedding', () => {
  it('shares one request between concurrent and recent asks for the same text', async () => {
    const a = embedLiveQuery('How did you scale it?');
    const b = embedLiveQuery('How did you scale it?');
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toBe(await b);
    await embedLiveQuery('How did you scale it?');
    expect(h.calls.map((c) => c.text)).toEqual(['How did you scale it?']);
    // A different text, or another embedding space, is its own request.
    void embedLiveQuery('Why this company?');
    h.model = 'text-embedding-3-large';
    void embedLiveQuery('How did you scale it?');
    expect(h.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(100);
  });

  it('aborts a request past the deadline and rejects, so the caller ranks lexically', async () => {
    h.delay = 60_000;
    const p = embedLiveQuery('Tell me about yourself.');
    const seen = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(LIVE_EMBED_DEADLINE_MS);
    expect(await seen).toBeInstanceOf(EmbedDeadlineError);
    expect(h.calls[0].signal?.aborted).toBe(true);
  });

  it('a late or failed embedding is not reused — the next question tries again', async () => {
    h.fail = true;
    const first = embedLiveQuery('Walk me through the outage.').catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe('failed');
    h.fail = false;
    const again = embedLiveQuery('Walk me through the outage.');
    await vi.advanceTimersByTimeAsync(100);
    await expect(again).resolves.toBeInstanceOf(Float32Array);
    expect(h.calls).toHaveLength(2);
  });

  it('an entry expires after a few seconds', async () => {
    const p = embedLiveQuery('Same question.');
    await vi.advanceTimersByTimeAsync(100);
    await p;
    await vi.advanceTimersByTimeAsync(20_000);
    void embedLiveQuery('Same question.');
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
  });
});
