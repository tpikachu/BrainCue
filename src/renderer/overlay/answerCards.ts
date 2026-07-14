import type { AnswerMetaEvent, ContextSentEvent } from '@shared/types';

/** One generated answer (interview question or coding solve). With history on, past
 *  cards are kept (collapsed) instead of being replaced; each is individually removable.
 *  `questionId` is the backend id the answer events carry, so streamed deltas / a
 *  per-card regenerate route to THIS card (not just "the last one"). */
export interface AnswerCard {
  id: number; // local, stable — React key + remove/collapse
  questionId: string; // backend question id (routes answer events + regenerate)
  question: string;
  answer: string;
  meta: AnswerMetaEvent | null;
  context: ContextSentEvent | null;
  followup: string | null; // predicted likely interviewer follow-up (post-stream)
  streaming: boolean;
  collapsed: boolean;
  isCoding: boolean; // a coding-solver card (not a live-session question → not regenerable)
}

/** A fresh, expanded, streaming card for a newly detected question. */
export function makeCard(
  id: number,
  questionId: string,
  question: string,
  isCoding = false,
): AnswerCard {
  return {
    id,
    questionId,
    question,
    answer: '',
    meta: null,
    context: null,
    followup: null,
    streaming: true,
    collapsed: false,
    isCoding,
  };
}

/** Apply a patch to the newest (current) card. No-op on an empty list. */
export function patchLast(cards: AnswerCard[], patch: Partial<AnswerCard>): AnswerCard[] {
  if (!cards.length) return cards;
  return [...cards.slice(0, -1), { ...cards[cards.length - 1], ...patch }];
}

/** Merge a patch into the card with this backend questionId. No-op if none match. */
export function patchById(
  cards: AnswerCard[],
  questionId: string,
  patch: Partial<AnswerCard>,
): AnswerCard[] {
  return cards.map((c) => (c.questionId === questionId ? { ...c, ...patch } : c));
}

/** Append a streamed chunk to the answer of the card with this questionId. */
export function appendById(cards: AnswerCard[], questionId: string, chunk: string): AnswerCard[] {
  return cards.map((c) => (c.questionId === questionId ? { ...c, answer: c.answer + chunk } : c));
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
