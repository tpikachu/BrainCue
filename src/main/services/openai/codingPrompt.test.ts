import { describe, it, expect } from 'vitest';
import { codingRules } from './codingPrompt';

describe('codingRules', () => {
  it('always mandates the four beats in order: understanding → plan → solution → evaluation', () => {
    for (const format of ['general', 'technical'] as const) {
      const p = codingRules('python', format);
      const beats = ['**Understanding**', '**Plan**', '**Solution**', '**Evaluation**'];
      const positions = beats.map((b) => p.indexOf(b));
      expect(positions.every((i) => i >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions); // in order
    }
  });

  it('writes the solution in the chosen language with mandatory comments', () => {
    const p = codingRules('rust', 'general');
    expect(p).toContain('Write the solution in rust');
    expect(p).toMatch(/inline comments/i);
    expect(p).toContain('tagged rust');
  });

  it('shapes delivery by the selected style: general = spoken walkthrough, technical = thorough', () => {
    const general = codingRules('js', 'general');
    expect(general).toContain('DELIVERY = EXPLANATION (spoken walkthrough)');
    expect(general).toContain('comes down to');
    const technical = codingRules('js', 'technical');
    expect(technical).toContain('DELIVERY = DETAILED');
    expect(technical).toMatch(/why alternatives lose/);
    expect(technical).toMatch(/edge cases handled/);
    // The retired formats are gone from the prompt entirely.
    for (const p of [general, technical]) expect(p).not.toMatch(/KEY POINTS|Do NOT impose/);
  });

  it('defaults to the general (spoken walkthrough) delivery and keeps the optimality mandate', () => {
    const p = codingRules('go');
    expect(p).toContain('spoken walkthrough');
    expect(p).toMatch(/OPTIMAL solution/);
  });
});
