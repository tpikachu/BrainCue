/**
 * Echo guard — keeps the user's microphone from re-transcribing the call.
 *
 * A session hears two streams: the call (system audio) and the microphone.
 * On headphones they are disjoint. On laptop speakers the microphone hears
 * the speakers too, so every remote turn arrives twice — once from the call,
 * once ~0–1.5 s later from the mic, with the user's own speaker label.
 * Chromium's echo cancellation only cancels audio the renderer itself plays,
 * not Zoom/Meet in another window, so this has to happen at the text level.
 *
 * Rules (pure — the session supplies `commit` and time):
 *  - A remote turn is recorded for `windowMs`. Any HELD own turn with the same
 *    words is an echo and is dropped.
 *  - An own turn that matches a recent remote turn is dropped at once;
 *    otherwise it is held for `holdMs` (the call's copy usually lands first,
 *    but both transcribers endpoint on the same silence, so either order is
 *    possible) and then committed. The microphone is never the trigger path,
 *    so the hold costs nothing on questions.
 *  - Short turns ("Okay", "Thank you") only match on exact words: they are
 *    too common to fuzzy-match.
 */
export const ECHO_HOLD_MS = 1500;
export const ECHO_WINDOW_MS = 6000;
const FUZZY_MIN_WORDS = 3;
const FUZZY_MIN_OVERLAP = 0.8;

interface Pending {
  words: string[];
  commit: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Lower-cased words with punctuation stripped, so "Fine. Let's decide" and
 *  "fine let's decide" compare equal. */
export function turnWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Do two turns say the same thing? Exact for short turns; for longer ones,
 *  ≥ 80 % of the shorter turn's words appear in the longer (the mic often
 *  catches a clipped or slightly mis-heard copy). */
export function sameWords(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < FUZZY_MIN_WORDS) {
    return short.length === long.length && short.every((w, i) => w === long[i]);
  }
  const bag = new Map<string, number>();
  for (const w of long) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of short) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return hit / short.length >= FUZZY_MIN_OVERLAP;
}

export class EchoGuard {
  private remote: { words: string[]; at: number }[] = [];
  private readonly pending = new Set<Pending>();
  private readonly holdMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  private readonly onDrop: (words: number) => void;

  constructor(opts: { holdMs?: number; windowMs?: number; now?: () => number; onDrop?: (words: number) => void } = {}) {
    this.holdMs = opts.holdMs ?? ECHO_HOLD_MS;
    this.windowMs = opts.windowMs ?? ECHO_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.onDrop = opts.onDrop ?? (() => {});
  }

  /** The call said this. Drops any held own turn that is its echo. */
  remoteTurn(text: string): void {
    const words = turnWords(text);
    if (words.length === 0) return;
    const at = this.now();
    this.remote = this.remote.filter((r) => at - r.at <= this.windowMs);
    this.remote.push({ words, at });
    for (const p of [...this.pending]) {
      if (sameWords(p.words, words)) this.drop(p);
    }
  }

  /** The microphone said this. Returns true when it was taken (held, then
   *  committed unless the call says the same words meanwhile), false when it
   *  was dropped as an echo right away. */
  ownTurn(text: string, commit: () => void): boolean {
    const words = turnWords(text);
    const at = this.now();
    this.remote = this.remote.filter((r) => at - r.at <= this.windowMs);
    if (this.remote.some((r) => sameWords(r.words, words))) {
      this.onDrop(words.length);
      return false;
    }
    const p: Pending = {
      words,
      commit,
      timer: setTimeout(() => {
        this.pending.delete(p);
        commit();
      }, this.holdMs),
    };
    this.pending.add(p);
    return true;
  }

  /** Commit every held own turn now (the session is ending). */
  flush(): void {
    for (const p of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(p);
      p.commit();
    }
  }

  get held(): number {
    return this.pending.size;
  }

  private drop(p: Pending): void {
    clearTimeout(p.timer);
    this.pending.delete(p);
    this.onDrop(p.words.length);
  }
}
