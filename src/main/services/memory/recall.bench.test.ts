import { describe, expect, it } from 'vitest';
import { buildIndex, lexicalScore, tokenize } from './lexical';
import { cosineSimilarity } from '../rag/vectorMath';

/**
 * Recall cost at scale — the measurement behind the scale trigger points in
 * docs/14-MEMORY.md §5, so "when do we need an ANN index?" is answered with
 * numbers instead of a guess.
 *
 * This benchmarks the two things recall actually does per query: cosine over
 * every candidate vector, and lexical scoring over every candidate string. It
 * deliberately does NOT go through the database — that would measure sql.js,
 * which is not what ships. Real embedding width (1536) is used because the
 * per-row cost is dominated by it.
 *
 * The assertions are generous ceilings, not targets: CI machines vary wildly,
 * and a benchmark that fails on a busy runner teaches people to ignore it.
 * The printed numbers are the point.
 */

const DIM = 1536;

function syntheticVector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  // Cheap deterministic pseudo-random — Math.random would make runs
  // incomparable, and the distribution does not matter for timing.
  let x = seed * 2654435761;
  for (let i = 0; i < DIM; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return v;
}

const SUBJECTS = ['atlas', 'checkout', 'billing', 'onboarding', 'search', 'sync'];
function syntheticContent(i: number): string {
  return (
    `Ticket ATL-${4000 + i} tracks the ${SUBJECTS[i % SUBJECTS.length]} regression ` +
    `raised in the weekly review; the owner agreed to follow up by the end of sprint ${i % 30}.`
  );
}

function measure(rows: number): { semanticMs: number; lexicalMs: number } {
  const vectors = Array.from({ length: rows }, (_, i) => syntheticVector(i));
  const contents = Array.from({ length: rows }, (_, i) => syntheticContent(i));
  const query = syntheticVector(999_999);
  const queryTokens = tokenize('what is the status of ticket ATL-4231');

  const t0 = performance.now();
  for (const v of vectors) cosineSimilarity(query, v);
  const semanticMs = performance.now() - t0;

  const t1 = performance.now();
  const index = buildIndex(contents);
  for (const c of contents) lexicalScore(queryTokens, c, index);
  const lexicalMs = performance.now() - t1;

  return { semanticMs, lexicalMs };
}

describe('recall cost at scale', () => {
  it('measures the per-query cost at 1k / 10k rows', () => {
    const results: Record<number, { semanticMs: number; lexicalMs: number }> = {};
    for (const rows of [1_000, 10_000]) {
      results[rows] = measure(rows);
      const { semanticMs, lexicalMs } = results[rows];
      console.log(
        `recall @ ${rows.toLocaleString()} rows: semantic ${semanticMs.toFixed(1)}ms · ` +
          `lexical ${lexicalMs.toFixed(1)}ms · total ${(semanticMs + lexicalMs).toFixed(1)}ms`,
      );
    }

    // Scaling sanity: 10× the rows must not cost dramatically more than 10×
    // the time. A superlinear jump means an accidental O(n²) crept in.
    const ratio =
      (results[10_000].semanticMs + results[10_000].lexicalMs) /
      Math.max(0.01, results[1_000].semanticMs + results[1_000].lexicalMs);
    expect(ratio).toBeLessThan(40);

    // Generous ceiling — if a query costs more than this even on a slow
    // runner, the scale work (worker-thread scoring, ANN index) is overdue.
    expect(results[10_000].semanticMs + results[10_000].lexicalMs).toBeLessThan(5_000);
  });

  it('lexical indexing stays cheap relative to vector scoring', () => {
    // Justifies doing lexical work in JS rather than reaching for FTS5 (which
    // the test harness cannot run — see lexical.ts).
    const { semanticMs, lexicalMs } = measure(5_000);
    console.log(
      `recall @ 5,000 rows: semantic ${semanticMs.toFixed(1)}ms · lexical ${lexicalMs.toFixed(1)}ms`,
    );
    expect(lexicalMs).toBeLessThan(semanticMs * 8);
  });
});
