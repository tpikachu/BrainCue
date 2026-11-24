import { describe, expect, it } from 'vitest';
import { createSettingsFeed } from './settingsFeed';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('settings snapshots reaching a view out of order (AI-01)', () => {
  it('a read that returns after a newer push does not restore the older state', async () => {
    const seen: string[] = [];
    const feed = createSettingsFeed<string>((s) => seen.push(s));
    const old = deferred<string>();
    const pending = feed.request(old.promise);
    feed.push('haiku');
    old.resolve('sonnet');
    await pending;
    expect(seen).toEqual(['haiku']);
  });

  it('a reply asked for before the user edited is stale', async () => {
    const seen: string[] = [];
    const feed = createSettingsFeed<string>((s) => seen.push(s));
    const old = deferred<string>();
    const pending = feed.request(old.promise);
    feed.edited();
    old.resolve('astra');
    await pending;
    expect(seen).toEqual([]);
  });

  it('of two writes in flight, the later one wins whichever reply lands last', async () => {
    const seen: string[] = [];
    const feed = createSettingsFeed<string>((s) => seen.push(s));
    const first = deferred<string>();
    const a = feed.request(first.promise);
    feed.edited();
    await feed.request(Promise.resolve('model+effort'));
    first.resolve('model only');
    await a;
    expect(seen).toEqual(['model+effort']);
  });

  it('applies an undisturbed reply, and resolves every request with its snapshot', async () => {
    const seen: string[] = [];
    const feed = createSettingsFeed<string>((s) => seen.push(s));
    await expect(feed.request(Promise.resolve('fresh'))).resolves.toBe('fresh');
    expect(seen).toEqual(['fresh']);
    await expect(feed.request(Promise.reject(new Error('ipc')))).rejects.toThrow('ipc');
  });
});
