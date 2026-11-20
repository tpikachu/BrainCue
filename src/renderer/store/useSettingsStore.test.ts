import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

// The dashboard's settings refresh path, under the Cue Card's ordering rule
// (M7.2a review, AI-01): a read that lands after main's newer push must not
// replace it. Only the preload bridge is faked.
const get = vi.fn();
vi.mock('../lib/api', () => ({
  api: { settings: { get: () => get(), setApiKey: vi.fn(async () => true), clearApiKey: vi.fn(async () => true) } },
}));

const { useSettingsStore } = await import('./useSettingsStore');

const s = (answer: string) => ({ effectiveModels: { answer } }) as unknown as AppSettings;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('dashboard settings store ordering', () => {
  beforeEach(() => {
    get.mockReset();
    useSettingsStore.setState({ settings: null, loading: false });
  });

  it('a load that returns after a newer push keeps the pushed settings', async () => {
    const old = deferred<AppSettings>();
    get.mockReturnValueOnce(old.promise);
    const loading = useSettingsStore.getState().load();
    useSettingsStore.getState().receive(s('anthropic/claude-haiku-5-5'));
    old.resolve(s('anthropic/claude-sonnet-5-5'));
    await loading;
    expect(useSettingsStore.getState().settings?.effectiveModels?.answer).toBe('anthropic/claude-haiku-5-5');
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it('an undisturbed load, and the read after a key change, apply', async () => {
    get.mockResolvedValueOnce(s('gpt-6-luna'));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings?.effectiveModels?.answer).toBe('gpt-6-luna');
    get.mockResolvedValueOnce(s('anthropic/claude-sonnet-5-5'));
    await useSettingsStore.getState().saveApiKey('sk-test');
    expect(useSettingsStore.getState().settings?.effectiveModels?.answer).toBe('anthropic/claude-sonnet-5-5');
  });

  it('a failed load still clears the loading flag', async () => {
    get.mockRejectedValueOnce(new Error('ipc'));
    await expect(useSettingsStore.getState().load()).rejects.toThrow('ipc');
    expect(useSettingsStore.getState().loading).toBe(false);
  });
});
