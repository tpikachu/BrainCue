import { describe, expect, it } from 'vitest';
import { LatencyRecorder, percentile } from './latency';

describe('percentile', () => {
  it('nearest-rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
  });
});

describe('LatencyRecorder', () => {
  it('separates the first answer of the process (cold) from the rest', () => {
    const r = new LatencyRecorder();
    r.begin({ questionId: 'a', sessionId: 's', finalAt: 0, decidedAt: 100 });
    r.mark('a', { firstVisibleAt: 3000 });
    r.begin({ questionId: 'b', sessionId: 's', finalAt: 10_000, decidedAt: 10_050 });
    r.mark('b', { firstVisibleAt: 11_200 });
    const s = r.summary();
    expect(s.cold.finalToFirstVisible).toEqual({ n: 1, p50: 3000, p95: 3000 });
    expect(s.warm.finalToFirstVisible).toEqual({ n: 1, p50: 1200, p95: 1200 });
  });

  it('keeps the first first-visible mark and reports it once to the sink', () => {
    const sunk: number[] = [];
    const r = new LatencyRecorder(10, (t) => sunk.push(t.firstVisibleAt!));
    r.begin({ questionId: 'a', sessionId: 's', finalAt: 0 });
    r.mark('a', { firstVisibleAt: 900 });
    r.mark('a', { firstVisibleAt: 2000 });
    expect(r.get('a')?.firstVisibleAt).toBe(900);
    expect(sunk).toEqual([900]);
  });

  it('counts detection latency for every evaluated turn, questions or not', () => {
    const r = new LatencyRecorder();
    r.decision(0, 5);
    r.decision(0, 700);
    r.decision(100, 50); // clock skew → ignored
    expect(r.summary().all.finalToDecision).toEqual({ n: 2, p50: 5, p95: 700 });
  });

  it('is bounded', () => {
    const r = new LatencyRecorder(3);
    for (let i = 0; i < 10; i++) r.begin({ questionId: `q${i}`, sessionId: 's', finalAt: i });
    expect(r.all().map((t) => t.questionId)).toEqual(['q7', 'q8', 'q9']);
  });
});
