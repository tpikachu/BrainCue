import { describe, it, expect } from 'vitest';
import { codingRules } from './codingPrompt';

describe('codingRules', () => {
  it('always mandates the four beats in order: understanding → plan → solution → evaluation', () => {
    for (const format of [
      'key_points',
      'explanation',
      'detailed',
      'story_teller',
      'star',
    ] as const) {
      const p = codingRules('python', format);
      const beats = ['**Understanding**', '**Plan**', '**Solution**', '**Evaluation**'];
      const positions = beats.map((b) => p.indexOf(b));
      expect(positions.every((i) => i >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions); // in order
    }
  });

  it('writes the solution in the chosen language with mandatory comments', () => {
    const p = codingRules('rust', 'explanation');
    expect(p).toContain('Write the solution in rust');
    expect(p).toMatch(/inline comments/i);
    expect(p).toContain('tagged rust');
  });

  it('shapes delivery by the selected format', () => {
    expect(codingRules('js', 'key_points')).toContain('DELIVERY = KEY POINTS');
    expect(codingRules('js', 'explanation')).toContain('spoken walkthrough');
    expect(codingRules('js', 'explanation')).toContain('comes down to');
    expect(codingRules('js', 'detailed')).toContain('DELIVERY = DETAILED');
    // story_teller narrates like explanation — coding answers aren't personal stories.
    expect(codingRules('js', 'story_teller')).toContain('spoken walkthrough');
    // …and neither is a coding answer a behavioural one. The format control is
    // global, so a candidate who picked STAR for the behavioural round must not
    // get Situation/Task/Action/Result imposed on "reverse a linked list".
    expect(codingRules('js', 'star')).toContain('spoken walkthrough');
    expect(codingRules('js', 'star')).toContain('Do NOT impose');
  });

  it('defaults to the explanation delivery and keeps the optimality mandate', () => {
    const p = codingRules('go');
    expect(p).toContain('spoken walkthrough');
    expect(p).toMatch(/OPTIMAL solution/);
  });
});
