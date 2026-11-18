/**
 * Does streamed answer text hold something a person can actually use yet?
 *
 * The latency record's acceptance measure is the first USEFUL answer paint
 * (M7.2b / PERF-01). Answers open with Markdown — the bold lead begins with
 * `**`, bullets with `- ` — so the first nonblank chunk is often only
 * syntax: painting it shows nothing readable. Text counts once it holds a
 * word: two letters or digits in a row, or one character of a script that
 * writes without spaces (CJK). Markdown markers, citation brackets ("[1]"),
 * punctuation and whitespace never do. A lone one-letter word ("I") waits
 * for the next token — conservative by at most one token.
 */
export function hasUsefulText(text: string): boolean {
  return /[\p{L}\p{N}]{2,}|\p{Lo}/u.test(text.replace(/\[\[PRONUNCIATION\]\]/g, ''));
}
