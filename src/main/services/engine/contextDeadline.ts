/** Normal interview cues cannot spend the entire response budget waiting
 * for a semantic lookup. Coding has its own, longer budget. */
export const INTERVIEW_CONTEXT_WAIT_MS = 350;
export const CODING_CONTEXT_WAIT_MS = 2500;

/** Stops waiting; background retrieval remains bounded by liveEmbed's own
 * timeout. Its late result cannot replace an answer that already started. */
export async function withinContextBudget<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: () => void = () => {};
  const deadline = new Promise<null>((resolve) => {
    cancelled = () => resolve(null);
    signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancelled);
  }
}
