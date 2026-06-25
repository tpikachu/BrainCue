import { clipboard } from 'electron';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import { solveFromOcr } from '../openai/coding';
import { solveFromImages } from '../openai/vision';
import { normalizeOpenAIError } from '../openai/client';
import type { AnswerEvent } from '../openai/answer';
import { showOverlay } from '../../windows/overlayWindow';

// Accumulated problem screenshots for the current solve. A long problem scrolls
// past one viewport, so the user captures several (scroll → capture → repeat) and
// they're sent together. Cleared after a solve. Capped so a runaway can't bloat one
// request.
const MAX_CAPTURES = 8;
let captureBuffer: string[] = [];

function broadcastBuffer(): void {
  broadcast(EVENTS.captureBuffer, { images: captureBuffer }, ['overlay']);
}

/** Add a captured region to the buffer (from the region selector). */
export function addCapture(dataUrl: string): void {
  if (captureBuffer.length >= MAX_CAPTURES) captureBuffer.shift(); // keep the most recent N
  captureBuffer.push(dataUrl);
  showOverlay();
  broadcastBuffer();
}

export function clearCaptures(): void {
  captureBuffer = [];
  broadcastBuffer();
}

/** Solve all accumulated screenshots in one vision call, then clear the buffer. */
export function solveCaptures(): Promise<void> {
  if (captureBuffer.length === 0) return Promise.resolve();
  const images = captureBuffer;
  captureBuffer = [];
  broadcastBuffer();
  const label =
    images.length > 1
      ? `Coding problem (${images.length} screenshots)`
      : 'Coding problem (from screenshot)';
  return streamToOverlay(solveFromImages(images), label);
}

async function streamToOverlay(gen: AsyncGenerator<AnswerEvent>, label: string): Promise<void> {
  const questionId = crypto.randomUUID();
  showOverlay();
  broadcast(EVENTS.questionDetected, { id: questionId, text: label, type: 'coding' }, ['overlay']);
  try {
    for await (const ev of gen) {
      if (ev.type === 'delta') {
        broadcast(EVENTS.answerDelta, { questionId, token: ev.token }, ['overlay']);
      } else if (ev.type === 'meta') {
        broadcast(EVENTS.answerMeta, { questionId, ...ev }, ['overlay']);
      }
    }
  } catch (e) {
    broadcast(EVENTS.sessionError, { message: normalizeOpenAIError(e) }, ['overlay', 'main']);
  } finally {
    broadcast(EVENTS.answerDone, { questionId }, ['overlay']);
  }
}

/** Stream a coding solution from plain text (clipboard). */
export function runCodingSolve(text: string): Promise<void> {
  return streamToOverlay(solveFromOcr(text), 'Coding problem (from clipboard)');
}

/** Stream a coding solution from a single screenshot/region image (OpenAI vision). */
export function runCodingSolveFromImage(dataUrl: string): Promise<void> {
  return streamToOverlay(solveFromImages([dataUrl]), 'Coding problem (from screenshot)');
}

/**
 * Quick coding help from the clipboard: the user copies the problem text and
 * presses the hotkey; we answer from that text. Reliable, no OCR.
 */
export async function quickSolveFromClipboard(): Promise<void> {
  const text = clipboard.readText().trim();
  if (!text) {
    const questionId = crypto.randomUUID();
    showOverlay();
    broadcast(EVENTS.questionDetected, { id: questionId, text: 'Coding help', type: 'coding' }, [
      'overlay',
    ]);
    broadcast(
      EVENTS.sessionError,
      { message: 'Clipboard is empty. Copy the problem text first, then press the hotkey.' },
      ['overlay'],
    );
    broadcast(EVENTS.answerDone, { questionId }, ['overlay']);
    return;
  }
  await runCodingSolve(text);
}
