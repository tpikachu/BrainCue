import { describe, expect, it } from 'vitest';
import { hasUsefulText } from './usefulText';

describe('hasUsefulText — the first useful answer paint', () => {
  it('Markdown syntax, punctuation, citations and whitespace alone are not an answer', () => {
    for (const s of ['', '   ', '**', '** ', '- ', '\n- **', '#', '> ', '`', '[1]', '...', '—', '[[PRONUNCIATION]]', '*I'])
      expect(hasUsefulText(s), JSON.stringify(s)).toBe(false);
  });

  it('a real word is, wherever the markup puts it', () => {
    for (const s of ['**I led', '- Cut', 'We', '**42', 'Hi.', '架构'])
      expect(hasUsefulText(s), JSON.stringify(s)).toBe(true);
  });
});
