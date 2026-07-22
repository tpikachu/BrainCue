import { clipboard } from 'electron';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import {
  emitContributionDelta,
  emitContributionDone,
  emitContributionMeta,
  emitContributionOpen,
} from '../../ipc/contributionBridge';
import { solveFromOcr } from '../openai/coding';
import { solveFromImages } from '../openai/vision';
import { normalizeOpenAIError } from '../openai/client';
import type { AnswerEvent } from '../openai/answer';
import { showOverlay } from '../../windows/overlayWindow';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { sessionManager } from '../session/sessionManager';
import type { AnswerFormat } from '@shared/types';

/** The programming language the solver writes solutions in (Cue Card setting; JS default). */
const codingLanguage = (): string =>
  settingsRepo.get(SETTINGS_KEYS.codingLanguage) || 'javascript';

/** The four-beat delivery follows the live Cue Card's Answer Format when a session
 *  is running; outside a session the coding default is the spoken explanation. */
const codingFormat = (): AnswerFormat => sessionManager.activeAnswerFormat() ?? 'explanation';

// Accumulated problem screenshots for the current solve. A long problem scrolls
// past one viewport, so the user captures several (scroll → capture → repeat) and
// they're sent together. Cleared after a solve. Capped so a runaway can't bloat one
// request.
const MAX_CAPTURES = 8;
let captureBuffer: string[] = [];
// The most recent solve's input, so the Cue Card's per-card ↻ can re-solve the SAME
// problem (e.g. after switching language) without re-copying or re-capturing it.
let lastSolve: { text: string } | { images: string[] } | null = null;

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
  lastSolve = { images };
  captureBuffer = [];
  broadcastBuffer();
  const label =
    images.length > 1
      ? `Coding problem (${images.length} screenshots)`
      : 'Coding problem (from screenshot)';
  return streamToOverlay(
    (signal) => solveFromImages(images, codingLanguage(), codingFormat(), signal),
    label,
  );
}

// The one in-flight solve. A new solve ABORTS the previous one — concurrent solves
// would interleave in the Cue Card and double the spend for an answer nobody reads.
let activeSolve: AbortController | null = null;

async function streamToOverlay(
  makeGen: (signal: AbortSignal) => AsyncGenerator<AnswerEvent>,
  label: string,
): Promise<void> {
  activeSolve?.abort();
  const abort = new AbortController();
  activeSolve = abort;

  const questionId = crypto.randomUUID();
  showOverlay();
  emitContributionOpen(
    { contributionId: questionId, kind: 'code', title: label, legacyExtra: { type: 'coding' } },
    ['overlay'],
  );
  try {
    for await (const ev of makeGen(abort.signal)) {
      if (ev.type === 'delta') {
        emitContributionDelta(questionId, ev.token, ['overlay']);
      } else if (ev.type === 'meta') {
        emitContributionMeta(questionId, { questionId, ...ev }, ['overlay']);
      }
    }
  } catch (e) {
    // Superseded by a newer solve — drop silently; the new stream owns the Cue Card.
    if (!abort.signal.aborted) {
      broadcast(EVENTS.sessionError, { message: normalizeOpenAIError(e) }, ['overlay', 'main']);
    }
  } finally {
    if (activeSolve === abort) activeSolve = null;
    emitContributionDone(questionId, ['overlay']);
  }
}

/** Stream a coding solution from plain text (clipboard). */
export function runCodingSolve(text: string): Promise<void> {
  lastSolve = { text };
  return streamToOverlay(
    (signal) => solveFromOcr(text, codingLanguage(), codingFormat(), signal),
    'Coding problem (from clipboard)',
  );
}

/** Stream a coding solution from a single screenshot/region image (OpenAI vision). */
export function runCodingSolveFromImage(dataUrl: string): Promise<void> {
  lastSolve = { images: [dataUrl] };
  return streamToOverlay(
    (signal) => solveFromImages([dataUrl], codingLanguage(), codingFormat(), signal),
    'Coding problem (from screenshot)',
  );
}

/** Re-run the most recent coding solve (same problem) — picks up the current
 *  language/model/effort, so the user can iterate via the Cue Card's per-card ↻. */
export function resolveLast(): Promise<void> {
  if (!lastSolve) {
    const questionId = crypto.randomUUID();
    showOverlay();
    emitContributionOpen(
      { contributionId: questionId, kind: 'code', title: 'Re-solve', legacyExtra: { type: 'coding' } },
      ['overlay'],
    );
    broadcast(EVENTS.sessionError, { message: 'Nothing to re-solve yet — solve a problem first.' }, [
      'overlay',
    ]);
    emitContributionDone(questionId, ['overlay']);
    return Promise.resolve();
  }
  const last = lastSolve;
  return streamToOverlay(
    (signal) =>
      'text' in last
        ? solveFromOcr(last.text, codingLanguage(), codingFormat(), signal)
        : solveFromImages(last.images, codingLanguage(), codingFormat(), signal),
    'Coding problem (re-solve)',
  );
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
    emitContributionOpen(
      {
        contributionId: questionId,
        kind: 'code',
        title: 'Coding help',
        legacyExtra: { type: 'coding' },
      },
      ['overlay'],
    );
    broadcast(
      EVENTS.sessionError,
      { message: 'Clipboard is empty. Copy the problem text first, then press the hotkey.' },
      ['overlay'],
    );
    emitContributionDone(questionId, ['overlay']);
    return;
  }
  await runCodingSolve(text);
}
