// Dependency-free word-level diff (classic LCS) for the base-vs-tailored resume
// comparison. Tokenizes into words + newlines so paragraph structure survives; each
// side gets its own segment stream (base: same+del, revised: same+add) ready to
// render side-by-side with highlights.

export type DiffOp = 'same' | 'add' | 'del';
export interface DiffSegment {
  op: DiffOp;
  text: string;
}

/** O(n·m) DP guard — beyond this the caller falls back to a plain side-by-side. */
const MAX_CELLS = 4_000_000;

function tokenize(text: string): string[] {
  return text.match(/\n|\S+/g) ?? [];
}

/** Rendered form of a token: words carry a trailing space, newlines stay literal —
 *  so concatenated segments read correctly inside a whitespace-pre-wrap container. */
function rendered(token: string): string {
  return token === '\n' ? '\n' : `${token} `;
}

function push(segs: DiffSegment[], op: DiffOp, token: string): void {
  const text = rendered(token);
  const last = segs[segs.length - 1];
  if (last && last.op === op) last.text += text;
  else segs.push({ op, text });
}

/**
 * Word-level diff of two texts. Returns one segment stream per side (base marks
 * deletions, revised marks additions; shared words are 'same' on both), or null
 * when the inputs are too large to diff responsively.
 */
export function wordDiff(
  base: string,
  revised: string,
): { base: DiffSegment[]; revised: DiffSegment[] } | null {
  const a = tokenize(base);
  const b = tokenize(revised);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // LCS lengths, bottom-up. Values fit Uint16: max LCS = min(n,m) ≤ √MAX_CELLS ≈ 2000.
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const baseSegs: DiffSegment[] = [];
  const revisedSegs: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(baseSegs, 'same', a[i]);
      push(revisedSegs, 'same', b[j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push(baseSegs, 'del', a[i]);
      i++;
    } else {
      push(revisedSegs, 'add', b[j]);
      j++;
    }
  }
  while (i < n) push(baseSegs, 'del', a[i++]);
  while (j < m) push(revisedSegs, 'add', b[j++]);
  return { base: baseSegs, revised: revisedSegs };
}
