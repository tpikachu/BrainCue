import type { MissReason } from '@shared/types';
import { isMissedCard, type CardModel } from './cards/model';

/**
 * What the live Cue Card shows, from the card feed (M6):
 *
 * - `current` — the ONE dominant card: whichever is streaming (so
 *   regenerating an older card brings it forward), else the newest card that
 *   was answered or is being answered. A missed question is never "current":
 *   it would push the last real answer out of view.
 * - `missed` — questions that were not answered (paused, recognised late,
 *   asked while others waited), each with its retry; always visible, in
 *   arrival order.
 * - `earlier` — every other card, in arrival order, behind one toggle.
 *
 * Pure: the feed (store/useOverlayStore, cards/model) keeps its own order and
 * routing — manual-Ask ownership, same-card revisions and arrival order are
 * decided by main and the reducer, never re-sorted here.
 */
export function cueLayout(cards: CardModel[]): {
  current: CardModel | null;
  missed: CardModel[];
  earlier: CardModel[];
} {
  const streaming = cards.find((c) => c.streaming) ?? null;
  const missed = cards.filter((c) => c !== streaming && isMissedCard(c));
  const rest = cards.filter((c) => !missed.includes(c));
  const current = streaming ?? rest[rest.length - 1] ?? null;
  return { current, missed, earlier: rest.filter((c) => c !== current) };
}

const MISS_LABEL: Record<MissReason, string> = {
  paused: 'Asked while paused',
  late: 'Recognised after the conversation moved on',
  'queue-full': 'Asked while other answers were waiting',
};

/** Why this missed question was not answered, in a few words. */
export function missLabel(c: CardModel): string {
  const why = c.meta?.missed;
  return why ? MISS_LABEL[why] : 'Not answered';
}
