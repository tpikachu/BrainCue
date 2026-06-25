import { describe, it, expect } from 'vitest';
import { makeCard, patchLast, addCard, removeCard, toggleCollapsed, type AnswerCard } from './answerCards';

const card = (id: number, over: Partial<AnswerCard> = {}): AnswerCard => ({
  ...makeCard(id, `q${id}`),
  ...over,
});

describe('makeCard', () => {
  it('starts expanded + streaming with an empty answer', () => {
    expect(makeCard(1, 'why hashmap?')).toEqual({
      id: 1,
      question: 'why hashmap?',
      answer: '',
      meta: null,
      context: null,
      streaming: true,
      collapsed: false,
    });
  });
});

describe('patchLast', () => {
  it('patches only the newest card', () => {
    const out = patchLast([card(1), card(2)], { answer: 'done', streaming: false });
    expect(out[0]).toEqual(card(1)); // untouched
    expect(out[1]).toMatchObject({ id: 2, answer: 'done', streaming: false });
  });
  it('is a no-op on an empty list', () => {
    expect(patchLast([], { answer: 'x' })).toEqual([]);
  });
  it('does not mutate the input array', () => {
    const input = [card(1)];
    patchLast(input, { answer: 'x' });
    expect(input[0].answer).toBe('');
  });
});

describe('addCard — history OFF (replace)', () => {
  it('drops prior cards, keeping only the new one', () => {
    const out = addCard([card(1), card(2)], makeCard(3, 'q3'), false);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
  });
});

describe('addCard — history ON (keep + collapse)', () => {
  it('collapses prior cards, stops their streaming, and appends the new one expanded', () => {
    const prior = [card(1, { streaming: true, collapsed: false }), card(2, { streaming: true })];
    const out = addCard(prior, makeCard(3, 'q3'), true);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(out[0]).toMatchObject({ collapsed: true, streaming: false });
    expect(out[1]).toMatchObject({ collapsed: true, streaming: false });
    expect(out[2]).toMatchObject({ id: 3, collapsed: false, streaming: true });
  });
  it('preserves prior answers (history is not lost)', () => {
    const out = addCard([card(1, { answer: 'kept' })], makeCard(2, 'q2'), true);
    expect(out[0].answer).toBe('kept');
  });
});

describe('removeCard', () => {
  it('removes the matching id and leaves the rest', () => {
    expect(removeCard([card(1), card(2), card(3)], 2).map((c) => c.id)).toEqual([1, 3]);
  });
  it('is a no-op for an unknown id', () => {
    expect(removeCard([card(1)], 99).map((c) => c.id)).toEqual([1]);
  });
});

describe('toggleCollapsed', () => {
  it('flips only the targeted card', () => {
    const out = toggleCollapsed([card(1, { collapsed: false }), card(2, { collapsed: false })], 1);
    expect(out[0].collapsed).toBe(true);
    expect(out[1].collapsed).toBe(false);
  });
});
