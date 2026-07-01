import { describe, it, expect } from 'vitest';
import { splitPronunciation } from './pronunciation';

describe('splitPronunciation', () => {
  it('returns the whole answer as body when there is no guide', () => {
    const { body, entries } = splitPronunciation('I led the migration [1] and cut latency.');
    expect(body).toBe('I led the migration [1] and cut latency.');
    expect(entries).toEqual([]);
  });

  it('parses a full 4-field line and strips the guide from the body', () => {
    const a =
      'I tightened the **regulations** across teams.\n\n[[PRONUNCIATION]]\nregulations | noun, plural | regulation | reg-yuh-LAY-shunz';
    const { body, entries } = splitPronunciation(a);
    expect(body).toBe('I tightened the **regulations** across teams.');
    expect(body).not.toContain('[[PRONUNCIATION]]');
    expect(entries).toEqual([
      { word: 'regulations', pos: 'noun, plural', singular: 'regulation', say: 'reg-yuh-LAY-shunz' },
    ]);
  });

  it('keeps the respelling from a 3-field line (model dropped the optional singular)', () => {
    const a = 'Ran it on **nginx**.\n\n[[PRONUNCIATION]]\nnginx | noun | EN-jin-eks';
    const { entries } = splitPronunciation(a);
    expect(entries).toEqual([{ word: 'nginx', pos: 'noun', singular: '', say: 'EN-jin-eks' }]);
  });

  it('handles a 2-field (word | respelling) line', () => {
    const { entries } = splitPronunciation('x\n\n[[PRONUNCIATION]]\nKubernetes | koo-ber-NET-eez');
    expect(entries).toEqual([{ word: 'Kubernetes', pos: '', singular: '', say: 'koo-ber-NET-eez' }]);
  });

  it('matches the marker case- and space-insensitively (no guide leak into the body)', () => {
    const a = 'answer text\n\n[[ Pronunciation ]]\nfoo | noun | — | FOO';
    const { body, entries } = splitPronunciation(a);
    expect(body).toBe('answer text');
    expect(entries[0]).toMatchObject({ word: 'foo', say: 'FOO' });
  });

  it('normalizes "no singular" placeholders (—, –, -, n/a) to empty', () => {
    for (const ph of ['—', '–', '-', 'n/a', 'N/A', 'none']) {
      const { entries } = splitPronunciation(`x\n\n[[PRONUNCIATION]]\nword | noun | ${ph} | WERD`);
      expect(entries[0].singular).toBe('');
    }
  });

  it('hides a trailing partial marker prefix while streaming (no flicker)', () => {
    for (const partial of ['My answer.\n\n[[', 'My answer.\n\n[[P', 'My answer.\n\n[[PR', 'My answer.\n\n[[PRO']) {
      const { body, entries } = splitPronunciation(partial);
      expect(body).toBe('My answer.');
      expect(entries).toEqual([]);
    }
  });

  it('drops junk/degenerate lines but keeps valid ones', () => {
    const a = '[[PRONUNCIATION]]\njust prose with no pipe\nlonely\nGleason | proper noun | — | GLEE-sun';
    const { entries } = splitPronunciation(a);
    expect(entries).toEqual([
      { word: 'Gleason', pos: 'proper noun', singular: '', say: 'GLEE-sun' },
    ]);
  });
});
