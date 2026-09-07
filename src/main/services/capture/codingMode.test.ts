import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock everything codingMode touches except its own buffer logic.
vi.mock('electron', () => ({ clipboard: { readText: () => '' } }));
vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../windows/overlayWindow', () => ({ showOverlay: vi.fn() }));
vi.mock('../openai/coding', () => ({
  // eslint-disable-next-line require-yield
  solveFromOcr: vi.fn(async function* () {}),
}));
// The screenshot path goes through the vision seam (providerFor('vision')), which
// follows the coding task's provider — stub the registry with a fake VisionProvider.
const streamSolve = vi.hoisted(() => vi.fn(() => (async function* () {})()));
vi.mock('../../providers/registry', () => ({
  providerFor: () => ({ streamSolve }),
}));
// codingMode normalizes errors via providers/normalizeError, which falls back to the
// OpenAI client's normalizer; the client transitively loads electron (app.isPackaged)
// — stub it so the import chain stays node-safe.
vi.mock('../openai/client', () => ({ normalizeOpenAIError: (e: unknown) => String(e) }));
// codingMode reads the coding language from settings.repo (→ db → better-sqlite3),
// which can't load under the node test env — stub it (get → null ⇒ 'javascript' default).
vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { codingLanguage: 'coding_language' },
  settingsRepo: { get: () => null },
}));
// codingMode reads the live Answer Format from sessionManager (→ db/windows/openai) —
// stub it (null ⇒ the coding default, 'explanation').
vi.mock('../session/sessionManager', () => ({
  sessionManager: { activeAnswerFormat: () => null },
}));

import { addCapture, clearCaptures, solveCaptures } from './codingMode';
import { broadcast } from '../../ipc/broadcast';
import { EVENTS } from '@shared/ipc';

const lastBufferImages = (): string[] => {
  const calls = (broadcast as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    (c) => c[0] === EVENTS.captureBuffer,
  );
  return ((calls.at(-1)?.[1] as { images: string[] }) ?? { images: [] }).images;
};

beforeEach(() => {
  clearCaptures();
  vi.clearAllMocks();
});

describe('multi-image capture buffer', () => {
  it('adds a capture and broadcasts the updated buffer to the overlay', () => {
    addCapture('img-a');
    expect(broadcast).toHaveBeenCalledWith(EVENTS.captureBuffer, { images: ['img-a'] }, ['overlay']);
  });

  it('caps the buffer at 8, dropping the oldest', () => {
    for (let i = 0; i < 9; i++) addCapture(`img-${i}`);
    const imgs = lastBufferImages();
    expect(imgs).toHaveLength(8);
    expect(imgs[0]).toBe('img-1'); // img-0 (oldest) was dropped
    expect(imgs.at(-1)).toBe('img-8');
  });

  it('clearCaptures empties the buffer and broadcasts []', () => {
    addCapture('img-a');
    vi.clearAllMocks();
    clearCaptures();
    expect(lastBufferImages()).toEqual([]);
  });

  it('solveCaptures is a no-op on an empty buffer', async () => {
    await solveCaptures();
    expect(streamSolve).not.toHaveBeenCalled();
  });

  it('solveCaptures sends ALL buffered images in one vision-seam call, then clears', async () => {
    addCapture('img-1');
    addCapture('img-2');
    await solveCaptures();
    expect(streamSolve).toHaveBeenCalledTimes(1);
    expect(streamSolve).toHaveBeenCalledWith({
      imageDataUrls: ['img-1', 'img-2'],
      language: 'javascript',
      format: 'explanation',
      signal: expect.any(AbortSignal),
    });
    expect(lastBufferImages()).toEqual([]); // buffer cleared after solving
  });
});
