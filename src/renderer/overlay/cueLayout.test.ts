import { describe, expect, it } from 'vitest';
import { addCard, makeCard, type CardModel } from './cards/model';
import { cueLayout, missLabel } from './cueLayout';

/** M6: the live Cue Card shows ONE dominant card; missed questions stay
 *  visible with their retry; everything else is behind "Earlier". */

const card = (id: number, over: Partial<CardModel> = {}): CardModel => ({
  ...makeCard(id, `c${id}`, 'answer', `q${id}`),
  streaming: false,
  body: `answer ${id}`,
  ...over,
});
const missed = (id: number, why: 'paused' | 'late' | 'queue-full'): CardModel =>
  card(id, { body: '', meta: { questionId: `c${id}`, riskWarning: 'not answered', missed: why } });

describe('cueLayout', () => {
  it('the newest answered card is current; earlier ones keep arrival order', () => {
    const l = cueLayout([card(1), card(2), card(3)]);
    expect(l.current?.id).toBe(3);
    expect(l.earlier.map((c) => c.id)).toEqual([1, 2]);
    expect(l.missed).toEqual([]);
  });

  it('a streaming card is current even when older (a regenerated answer comes forward)', () => {
    const l = cueLayout([card(1, { streaming: true }), card(2), card(3)]);
    expect(l.current?.id).toBe(1);
    expect(l.earlier.map((c) => c.id)).toEqual([2, 3]);
  });

  it('a missed question never displaces the last answer, and is listed with why', () => {
    const l = cueLayout([card(1), missed(2, 'paused'), missed(3, 'late')]);
    expect(l.current?.id).toBe(1);
    expect(l.missed.map((c) => c.id)).toEqual([2, 3]);
    expect(l.missed.map(missLabel)).toEqual(['Asked while paused', 'Recognised after the conversation moved on']);
    expect(l.earlier).toEqual([]);
  });

  it('retrying a missed question (reset → streaming) makes it the current card', () => {
    const retried = card(2, { body: '', meta: null, streaming: true });
    const l = cueLayout([card(1), retried]);
    expect(l.current?.id).toBe(2);
    expect(l.missed).toEqual([]);
  });

  it('only missed cards: nothing is current, all are listed', () => {
    const l = cueLayout([missed(1, 'queue-full')]);
    expect(l.current).toBeNull();
    expect(l.missed.map(missLabel)).toEqual(['Asked while other answers were waiting']);
  });
});

describe('addCard keeps missed questions even with history off', () => {
  it('history off replaces answers but never drops an unanswered missed question', () => {
    const next = addCard([card(1), missed(2, 'paused')], makeCard(3, 'c3', 'answer', 'q3'), false);
    expect(next.map((c) => c.id)).toEqual([2, 3]);
  });
});
