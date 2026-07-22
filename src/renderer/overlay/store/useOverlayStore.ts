import { create } from 'zustand';
import type { ContributionOpenEvent, ContributionPatchEvent } from '@shared/types';
import {
  addCard,
  appendById,
  makeCard,
  patchById,
  removeCard,
  toggleCollapsed,
  type CardModel,
} from '../cards/model';

/** The Cue Card's contribution feed. A zustand store (not component state) so
 *  the once-subscribed IPC handlers dispatch via getState() with no stale-
 *  closure mirrors, and so the reducer logic (cards/model.ts) stays pure and
 *  unit-testable. */
interface OverlayCardsState {
  cards: CardModel[];
  /** ON by default: past cards collapse (and stay removable) when a new
   *  contribution arrives, instead of being replaced. */
  historyEnabled: boolean;
  nextId: number;

  open(ev: ContributionOpenEvent): void;
  /** Apply a batch of rAF-coalesced streamed chunks (from lib/streamBuffer). */
  append(chunks: [id: string, chunk: string][]): void;
  /** Merge only the fields present on the patch event (meta/context/followup). */
  patch(ev: ContributionPatchEvent): void;
  done(contributionId: string): void;
  /** Regenerate: clear THAT card's body and re-expand it, keep the card. */
  reset(contributionId: string): void;
  remove(id: number): void;
  toggle(id: number): void;
  clear(): void;
  /** Session stopped: drop every streaming cursor, keep the cards. */
  stopStreaming(): void;
  setHistoryEnabled(v: boolean): void;
}

export const useOverlayStore = create<OverlayCardsState>((set) => ({
  cards: [],
  historyEnabled: true,
  nextId: 0,

  open: (ev) =>
    set((s) => ({
      cards: addCard(
        s.cards,
        makeCard(s.nextId, ev.contributionId, ev.kind, ev.title),
        s.historyEnabled,
      ),
      nextId: s.nextId + 1,
    })),
  append: (chunks) =>
    set((s) => ({
      cards: chunks.reduce((acc, [id, chunk]) => appendById(acc, id, chunk), s.cards),
    })),
  patch: (ev) =>
    set((s) => ({
      cards: patchById(s.cards, ev.contributionId, {
        ...(ev.meta !== undefined ? { meta: ev.meta } : {}),
        ...(ev.context !== undefined ? { context: ev.context } : {}),
        ...(ev.followup !== undefined ? { followup: ev.followup } : {}),
      }),
    })),
  done: (contributionId) =>
    set((s) => ({ cards: patchById(s.cards, contributionId, { streaming: false }) })),
  reset: (contributionId) =>
    set((s) => ({
      cards: patchById(s.cards, contributionId, {
        body: '',
        meta: null,
        context: null,
        followup: null,
        streaming: true,
        collapsed: false, // regenerating a collapsed history card should surface it
      }),
    })),
  remove: (id) => set((s) => ({ cards: removeCard(s.cards, id) })),
  toggle: (id) => set((s) => ({ cards: toggleCollapsed(s.cards, id) })),
  clear: () => set({ cards: [] }),
  stopStreaming: () =>
    set((s) => ({ cards: s.cards.map((c) => ({ ...c, streaming: false })) })),
  setHistoryEnabled: (v) => set({ historyEnabled: v }),
}));
