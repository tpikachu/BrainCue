import { describe, it, expect } from 'vitest';
import {
  makeCard,
  patchById,
  appendById,
  addCard,
  removeCard,
  toggleCollapsed,
  type CardModel,
} from './model';

const card = (id: number, over: Partial<CardModel> = {}): CardModel => ({
  ...makeCard(id, `c${id}`, 'answer', `q${id}`),
  ...over,
});

describe('makeCard', () => {
  it('starts expanded + streaming with an empty body', () => {
    expect(makeCard(1, 'cid-1', 'answer', 'why hashmap?')).toEqual({
      id: 1,
      contributionId: 'cid-1',
      kind: 'answer',
      title: 'why hashmap?',
      body: '',
      meta: null,
      context: null,
      followup: null,
      streaming: true,
      collapsed: false,
    });
  });
  it('keeps the kind — including one this build does not know', () => {
    expect(makeCard(2, 'cid-2', 'code', 'Coding problem').kind).toBe('code');
    expect(makeCard(3, 'cid-3', 'galactic_forecast', 'From the future').kind).toBe(
      'galactic_forecast',
    );
  });
});

describe('patchById / appendById (route by backend contributionId)', () => {
  it('patchById patches the card matching the contributionId, not the last', () => {
    const out = patchById([card(1), card(2)], 'c1', { streaming: false });
    expect(out[0]).toMatchObject({ id: 1, streaming: false });
    expect(out[1]).toMatchObject({ id: 2, streaming: true }); // untouched
  });
  it('patchById is a no-op when no card matches', () => {
    const input = [card(1)];
    expect(patchById(input, 'nope', { body: 'x' })).toEqual(input);
  });
  it('appendById appends a chunk to the matching card only', () => {
    const out = appendById([card(1, { body: 'A' }), card(2, { body: 'B' })], 'c2', 'C');
    expect(out[0].body).toBe('A');
    expect(out[1].body).toBe('BC');
  });
  it('does not mutate the input array', () => {
    const input = [card(1)];
    appendById(input, 'c1', 'x');
    expect(input[0].body).toBe('');
  });
});

describe('addCard — history OFF (replace)', () => {
  it('drops prior cards, keeping only the new one', () => {
    const out = addCard([card(1), card(2)], makeCard(3, 'c3', 'answer', 'q3'), false);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
  });
});

describe('addCard — history ON (keep + collapse)', () => {
  it('collapses prior cards, stops their streaming, and appends the new one expanded', () => {
    const prior = [card(1, { streaming: true, collapsed: false }), card(2, { streaming: true })];
    const out = addCard(prior, makeCard(3, 'c3', 'answer', 'q3'), true);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(out[0]).toMatchObject({ collapsed: true, streaming: false });
    expect(out[1]).toMatchObject({ collapsed: true, streaming: false });
    expect(out[2]).toMatchObject({ id: 3, collapsed: false, streaming: true });
  });
  it('preserves prior bodies (history is not lost)', () => {
    const out = addCard([card(1, { body: 'kept' })], makeCard(2, 'c2', 'answer', 'q2'), true);
    expect(out[0].body).toBe('kept');
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
