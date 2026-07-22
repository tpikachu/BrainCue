/** Streamed tokens arrive far faster than the screen refreshes. Buffer them PER
 *  CONTRIBUTION (streams can overlap — e.g. a coding solve during a live answer)
 *  and flush once per animation frame so the (re-parsed) markdown renders at
 *  most ~60×/sec instead of once per token. One buffer per contribution id
 *  means concurrent streams can never interleave into the wrong card. */
export interface StreamBuffer {
  push(id: string, token: string): void;
  /** Drop ONE stream's buffered tokens (its body is being reset/re-streamed). */
  drop(id: string): void;
  /** Flush now, synchronously (a stream just completed). */
  flush(): void;
  /** Cancel the scheduled frame and clear EVERY stream's buffer (session
   *  restart / full clear). */
  cancel(): void;
}

export function createStreamBuffer(
  onFlush: (chunks: [id: string, chunk: string][]) => void,
): StreamBuffer {
  const pending = new Map<string, string>();
  let handle: number | null = null;

  const flush = () => {
    handle = null;
    if (pending.size === 0) return;
    const chunks = [...pending.entries()];
    pending.clear();
    onFlush(chunks);
  };

  return {
    push(id, token) {
      pending.set(id, (pending.get(id) ?? '') + token);
      if (handle == null) handle = requestAnimationFrame(flush);
    },
    drop(id) {
      pending.delete(id);
    },
    flush,
    cancel() {
      if (handle != null) cancelAnimationFrame(handle);
      handle = null;
      pending.clear();
    },
  };
}
