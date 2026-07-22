import { beforeEach, describe, expect, it } from 'vitest';
import { useOverlayStore } from './useOverlayStore';

const open = (contributionId: string, kind = 'answer', title = 'Q?') =>
  useOverlayStore.getState().open({ contributionId, kind: kind as never, title });
const state = () => useOverlayStore.getState();

beforeEach(() => {
  useOverlayStore.setState({ cards: [], historyEnabled: true, nextId: 0 });
});

describe('open', () => {
  it('appends a streaming card with an increasing local id and the wire kind', () => {
    open('a', 'answer', 'first?');
    open('b', 'code', 'Coding problem');
    const { cards } = state();
    expect(cards.map((c) => c.id)).toEqual([0, 1]);
    expect(cards[1]).toMatchObject({ contributionId: 'b', kind: 'code', streaming: true });
  });

  it('history ON: keeps prior cards collapsed; OFF: replaces them', () => {
    open('a');
    open('b');
    expect(state().cards.map((c) => c.collapsed)).toEqual([true, false]);

    state().setHistoryEnabled(false);
    open('c');
    expect(state().cards.map((c) => c.contributionId)).toEqual(['c']);
  });
});

describe('streaming (append) — concurrent streams route by id', () => {
  it('interleaved chunk batches never cross into the other card', () => {
    open('live', 'answer', 'Tell me about X?');
    open('solve', 'code', 'Coding problem');
    // Interleaved rAF flushes, as when a coding solve streams during a live answer.
    state().append([
      ['live', 'Use a '],
      ['solve', 'function two'],
    ]);
    state().append([['solve', 'Sum(a) {']]);
    state().append([
      ['live', 'hashmap'],
      ['solve', ' … }'],
    ]);
    const byId = Object.fromEntries(state().cards.map((c) => [c.contributionId, c.body]));
    expect(byId.live).toBe('Use a hashmap');
    expect(byId.solve).toBe('function twoSum(a) { … }');
  });

  it('chunks for an unknown id are dropped silently (card was removed)', () => {
    open('a');
    state().append([['ghost', 'zzz']]);
    expect(state().cards[0].body).toBe('');
  });
});

describe('patch', () => {
  it('merges only the fields present on the event', () => {
    open('a');
    const context = { questionId: 'a', question: 'Q?', chunks: [] };
    state().patch({ contributionId: 'a', context });
    state().patch({ contributionId: 'a', meta: { questionId: 'a', riskWarning: 'careful' } });
    const card = state().cards[0];
    expect(card.context).toEqual(context); // meta patch did not clobber context
    expect(card.meta).toMatchObject({ riskWarning: 'careful' });
    expect(card.followup).toBeNull();
  });

  it('followup patches route by id, not to the newest card', () => {
    open('a');
    open('b');
    state().patch({ contributionId: 'a', followup: 'And then?' });
    expect(state().cards[0].followup).toBe('And then?');
    expect(state().cards[1].followup).toBeNull();
  });
});

describe('done / reset', () => {
  it('done stops streaming for that card only', () => {
    open('a');
    open('b');
    state().done('a');
    expect(state().cards.map((c) => c.streaming)).toEqual([false, true]);
  });

  it('reset clears the body + annotations, re-expands, and resumes streaming', () => {
    open('a');
    state().append([['a', 'old body']]);
    state().patch({ contributionId: 'a', followup: 'f' });
    state().done('a');
    state().toggle(0); // user collapsed it
    state().reset('a');
    expect(state().cards[0]).toMatchObject({
      body: '',
      followup: null,
      meta: null,
      context: null,
      streaming: true,
      collapsed: false,
    });
  });
});

describe('remove / clear / stopStreaming', () => {
  it('remove drops one card by local id; clear drops all', () => {
    open('a');
    open('b');
    state().remove(0);
    expect(state().cards.map((c) => c.contributionId)).toEqual(['b']);
    state().clear();
    expect(state().cards).toEqual([]);
  });

  it('stopStreaming (session ended) drops every cursor but keeps the cards', () => {
    open('a');
    open('b');
    state().stopStreaming();
    expect(state().cards).toHaveLength(2);
    expect(state().cards.every((c) => !c.streaming)).toBe(true);
  });
});
