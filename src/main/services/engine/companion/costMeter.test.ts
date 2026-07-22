import { describe, expect, it, vi } from 'vitest';
import { CostMeter } from './costMeter';

describe('CostMeter', () => {
  it('accumulates calls, tokens, and a deterministic estimate', () => {
    const m = new CostMeter({ budgetCents: null });
    m.noteCall('classify');
    m.noteCall('answer', { prompt: 1000, completion: 1000 });
    const s = m.snapshot();
    expect(s.calls).toBe(2);
    expect(s.promptTokens).toBe(1000);
    expect(s.completionTokens).toBe(1000);
    // 0.05 + 0.5 flat + 2000 tokens × 0.05¢/1K = 0.65¢
    expect(s.estCents).toBeCloseTo(0.65, 5);
    expect(s.budgetCents).toBeNull();
  });

  it('without a budget it never warns or exhausts', () => {
    const m = new CostMeter({ budgetCents: null });
    for (let i = 0; i < 100; i++) m.noteCall('answer');
    expect(m.warned()).toBe(false);
    expect(m.exhausted()).toBe(false);
  });

  it('crosses the warn threshold before the hard budget, and warned latches', () => {
    const m = new CostMeter({ budgetCents: 1 }); // warn at 0.8¢
    for (let i = 0; i < 15; i++) m.noteCall('classify'); // 0.75¢
    expect(m.warned()).toBe(false);
    m.noteCall('classify'); // 0.80¢
    expect(m.warned()).toBe(true);
    expect(m.exhausted()).toBe(false);
    for (let i = 0; i < 4; i++) m.noteCall('classify'); // 1.0¢
    expect(m.exhausted()).toBe(true);
    expect(m.warned()).toBe(true); // still latched
  });

  it('notifies onChange with a fresh snapshot per call', () => {
    const seen: number[] = [];
    const m = new CostMeter({ budgetCents: null, onChange: (s) => seen.push(s.calls) });
    m.noteCall('classify');
    m.noteCall('card');
    expect(seen).toEqual([1, 2]);
  });

  it('never throws from its own bookkeeping', () => {
    const m = new CostMeter({ budgetCents: 0.0001, onChange: vi.fn() });
    expect(() => m.noteCall('embedding')).not.toThrow();
    expect(m.exhausted()).toBe(true);
  });
});
