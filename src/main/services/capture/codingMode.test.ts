import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock everything codingMode touches except its own buffer logic.
vi.mock('electron', () => ({ clipboard: { readText: () => '' } }));
vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../windows/overlayWindow', () => ({ showOverlay: vi.fn() }));
vi.mock('../openai/coding', () => ({
  // eslint-disable-next-line require-yield
  solveFromOcr: vi.fn(async function* () {}),
}));
vi.mock('../openai/vision', () => ({
  solveFromImages: vi.fn(() => (async function* () {})()),
}));
// codingMode imports normalizeOpenAIError from the client, which transitively loads
// electron (app.isPackaged) — stub it so the import chain stays node-safe.
vi.mock('../openai/client', () => ({ normalizeOpenAIError: (e: unknown) => String(e) }));

import { addCapture, clearCaptures, solveCaptures } from './codingMode';
import { broadcast } from '../../ipc/broadcast';
import { solveFromImages } from '../openai/vision';
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
    expect(solveFromImages).not.toHaveBeenCalled();
  });

  it('solveCaptures sends ALL buffered images in one call, then clears', async () => {
    addCapture('img-1');
    addCapture('img-2');
    await solveCaptures();
    expect(solveFromImages).toHaveBeenCalledTimes(1);
    expect(solveFromImages).toHaveBeenCalledWith(['img-1', 'img-2']);
    expect(lastBufferImages()).toEqual([]); // buffer cleared after solving
  });
});
