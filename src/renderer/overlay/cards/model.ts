import type { AnswerMetaEvent, ContextSentEvent } from '@shared/types';

/** One Cue Card entry: a Contribution being streamed/shown. With history on,
 *  past cards are kept (collapsed) instead of being replaced; each is
 *  individually removable. `contributionId` is the backend id the contribution
 *  events carry, so streamed deltas / patches / a per-card regenerate route to
 *  THIS card (not just "the last one"). `kind` is deliberately a plain string:
 *  an unknown future kind must still make a card (the registry renders it with
 *  the safe fallback view instead of crashing). */
export interface CardModel {
  id: number; // local, stable — React key + remove/collapse
  contributionId: string;
  kind: string; // ContributionKind, or an unknown future kind
  title: string; // e.g. the detected question / solve label
  body: string; // streamed markdown
  meta: AnswerMetaEvent | null;
  context: ContextSentEvent | null;
  followup: string | null; // predicted likely interviewer follow-up (post-stream)
  streaming: boolean;
  collapsed: boolean;
}

/** A fresh, expanded, streaming card for a newly opened contribution. */
export function makeCard(id: number, contributionId: string, kind: string, title: string): CardModel {
  return {
    id,
    contributionId,
    kind,
    title,
    body: '',
    meta: null,
    context: null,
    followup: null,
    streaming: true,
    collapsed: false,
  };
}

/** Merge a patch into the card with this backend contributionId. No-op if none match. */
export function patchById(
  cards: CardModel[],
  contributionId: string,
  patch: Partial<CardModel>,
): CardModel[] {
  return cards.map((c) => (c.contributionId === contributionId ? { ...c, ...patch } : c));
}

/** Append a streamed chunk to the body of the card with this contributionId. */
export function appendById(cards: CardModel[], contributionId: string, chunk: string): CardModel[] {
  return cards.map((c) =>
    c.contributionId === contributionId ? { ...c, body: c.body + chunk } : c,
  );
}

/** Add a new card. With history ON, prior cards collapse + stop streaming and
 *  are kept; with history OFF, they're replaced (only the new card remains). */
export function addCard(cards: CardModel[], card: CardModel, historyEnabled: boolean): CardModel[] {
  const prior = historyEnabled
    ? cards.map((c) => ({ ...c, collapsed: true, streaming: false }))
    : [];
  return [...prior, card];
}

/** Remove a card by local id (the per-card × button). */
export function removeCard(cards: CardModel[], id: number): CardModel[] {
  return cards.filter((c) => c.id !== id);
}

/** Toggle one card's collapsed state (clicking its header). */
export function toggleCollapsed(cards: CardModel[], id: number): CardModel[] {
  return cards.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c));
}
