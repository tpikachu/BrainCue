import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../openai/questions', () => ({ classifyQuestion: vi.fn() }));

import { assessUtterance } from '../questionHeuristics';
import { detectQuestion } from '../detector';
import { DETECTION_SET, type LabeledUtterance } from './detectionSet';
import { DETECTION_HOLDOUT } from './detectionHoldout';

/**
 * Deterministic detection evaluation — the RULE layer only, with the
 * classifier unavailable (every ambiguous turn takes the fallback). This is
 * the floor the app has with a dead or slow model, and it pins the rules
 * against regressions. Model accuracy is measured separately, live
 * (detection.live.test.ts) — a mock cannot establish it.
 */

function score(pairs: { predicted: boolean; actual: boolean }[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    if (p.predicted && p.actual) tp++;
    else if (p.predicted) fp++;
    else if (p.actual) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) };
}

async function rulesOnly(set: LabeledUtterance[]) {
  return Promise.all(
    set.map(async (u) => {
      const d = await detectQuestion(u.text, {
        recent: u.context,
        classify: async () => {
          throw new Error('classifier unavailable');
        },
      });
      return { u, predicted: d.act, actual: u.answer, source: d.source };
    }),
  );
}

describe('detection eval — rules only (classifier unavailable)', () => {
  it('held-out set (never used for tuning) — reported, with a loose floor', async () => {
    const results = await rulesOnly(DETECTION_HOLDOUT);
    const s = score(results);
    const misses = results.filter((r) => r.predicted !== r.actual).map((r) => `${r.actual ? 'FN' : 'FP'}: ${r.u.text}`);
    console.info(
      `[detection eval · rules only · HELD-OUT] n=${results.length} (pos ${results.filter((r) => r.actual).length}) ` +
        `precision=${s.precision.toFixed(3)} recall=${s.recall.toFixed(3)} ` +
        `decided-by-rule=${results.filter((r) => r.source === 'heuristic').length}/${results.length}\n  ${misses.join('\n  ')}`,
    );
    expect(s.precision).toBeGreaterThanOrEqual(0.8);
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('development set (rules were tuned on it)', async () => {
    const results = await Promise.all(
      DETECTION_SET.map(async (u) => {
        const d = await detectQuestion(u.text, {
          recent: u.context,
          classify: async () => {
            throw new Error('classifier unavailable');
          },
        });
        return { u, predicted: d.act, actual: u.answer, source: d.source };
      }),
    );
    const s = score(results);
    const decidedByRule = results.filter((r) => r.source === 'heuristic').length;
    const misses = results.filter((r) => r.predicted !== r.actual).map((r) => `${r.actual ? 'FN' : 'FP'}: ${r.u.text}`);
    // Reported in the test output for the handoff.
    console.info(
      `[detection eval · rules only · DEV] n=${results.length} (pos ${results.filter((r) => r.actual).length}) ` +
        `precision=${s.precision.toFixed(3)} recall=${s.recall.toFixed(3)} ` +
        `decided-by-rule=${decidedByRule}/${results.length}\n  ${misses.join('\n  ')}`,
    );
    // Regression floor for the rules alone. The live run with the model is
    // what is measured against the ≥95 % / ≥90 % targets.
    expect(s.precision).toBeGreaterThanOrEqual(0.95);
    expect(s.recall).toBeGreaterThanOrEqual(0.85);
  });

  it('no utterance in the set is a fragment (they are complete turns)', () => {
    expect(DETECTION_SET.filter((u) => assessUtterance(u.text).verdict === 'fragment').map((u) => u.text)).toEqual([]);
  });
});
