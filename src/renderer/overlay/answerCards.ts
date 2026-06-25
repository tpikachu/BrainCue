import type { AnswerMetaEvent, ContextSentEvent } from '@shared/types';

/** One generated answer (interview question or coding solve). With history on, past
 *  cards are kept (collapsed) instead of being replaced; each is individually removable. */
export interface AnswerCard {
  id: number;
  question: string;
  answer: string;
  meta: AnswerMetaEvent | null;
  context: ContextSentEvent | null;
  streaming: boolean;
  collapsed: boolean;
}

/** A fresh, expanded, streaming card for a newly detected question. */
export function makeCard(id: number, question: string): AnswerCard {
  return { id, question, answer: '', meta: null, context: null, streaming: true, collapsed: false };
}

/** Apply a patch to the newest (current) card. No-op on an empty list. */
export function patchLast(cards: AnswerCard[], patch: Partial<AnswerCard>): AnswerCard[] {
  if (!cards.length) return cards;
  return [...cards.slice(0, -1), { ...cards[cards.length - 1], ...patch }];
}

/** Add a new question card. With history ON, prior cards collapse + stop streaming
 *  and are kept; with history OFF, they're replaced (only the new card remains). */
export function addCard(cards: AnswerCard[], card: AnswerCard, historyEnabled: boolean): AnswerCard[] {
  const prior = historyEnabled ? cards.map((c) => ({ ...c, collapsed: true, streaming: false })) : [];
  return [...prior, card];
}

/** Remove a card by id (the per-card × button). */
export function removeCard(cards: AnswerCard[], id: number): AnswerCard[] {
  return cards.filter((c) => c.id !== id);
}

/** Toggle one card's collapsed state (clicking its header). */
export function toggleCollapsed(cards: AnswerCard[], id: number): AnswerCard[] {
  return cards.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c));
}
