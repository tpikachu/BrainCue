/**
 * Incremental sentence chunker for streamed TTS: tokens go in as they arrive,
 * complete sentences come out — so synthesis starts on the FIRST sentence while
 * the model is still writing the rest ("streamed speech" over a one-shot
 * speech capability). Pure and deterministic.
 */

/** Don't emit fragments shorter than this — "1." or "So." isn't worth a
 *  synthesis round-trip; it merges into the next sentence instead. */
const MIN_CHARS = 12;

/** Force a flush once the buffer grows past this without a sentence boundary
 *  (long bullet lists, code-ish output) so speech never stalls indefinitely. */
const MAX_BUFFER = 400;

/** Strip markdown the TTS would read out loud (the Cue Card renders it; the
 *  voice should not say "asterisk asterisk"). Citations like [1] / [M2] are
 *  visual anchors, not speech. */
export function speechText(text: string): string {
  return text
    .replace(/\[M?\d+\]/g, '') // [1] / [M1] citations
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export class SentenceStream {
  private buffer = '';

  /** Feed one token; returns any sentences completed by it (usually []). */
  push(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];
    // A sentence ends at . ! ? … followed by whitespace/end, or a newline
    // (bullets and paragraph breaks are natural speech pauses too).
    let m: RegExpExecArray | null;
    const boundary = /[.!?…](?=\s)|\n/g;
    let consumed = 0;
    while ((m = boundary.exec(this.buffer)) !== null) {
      const end = m.index + (this.buffer[m.index] === '\n' ? 0 : 1);
      const candidate = this.buffer.slice(consumed, end).trim();
      // Numbered/decimal guard: "3.5" or "1." mid-list — too short to speak
      // alone; leave it to merge with what follows.
      if (candidate.length >= MIN_CHARS) {
        out.push(candidate);
        consumed = end;
      }
    }
    if (consumed > 0) this.buffer = this.buffer.slice(consumed).replace(/^\s+/, '');
    if (this.buffer.length > MAX_BUFFER) {
      out.push(this.buffer.trim());
      this.buffer = '';
    }
    return out.map(speechText).filter((s) => s.length > 0);
  }

  /** The stream ended: whatever remains is the final sentence (or null). */
  flush(): string | null {
    const rest = speechText(this.buffer);
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }
}
