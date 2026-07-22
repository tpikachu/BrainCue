import type { Presence } from '@shared/types';

/** The ambient contribution kinds a presence level gates. */
export type AmbientKind = 'context' | 'open_question' | 'action_item' | 'decision' | 'warning';

/** A presence level is EXPLICIT numbers, not a vibe: per-kind confidence
 *  floors, a global gap between cards, and a per-kind gap. The dial never
 *  touches prompts — it only tightens or relaxes these deterministic gates. */
export interface PresenceConfig {
  /** false = summoned-only: no ambient cards at all (direct asks still work). */
  ambientEnabled: boolean;
  minConfidence: Record<AmbientKind, number>;
  /** Minimum gap between ANY two ambient cards. */
  cooldownMs: number;
  /** Minimum gap between two cards of the SAME kind. */
  perKindCooldownMs: number;
}

/** Contradiction/risk cards need high confidence at EVERY level — a wrong
 *  "you contradicted yourself" is the most trust-destroying card we can show. */
export const WARNING_FLOOR = 0.85;

export const PRESENCE_LEVELS: Record<Presence, PresenceConfig> = {
  summoned: {
    ambientEnabled: false,
    minConfidence: { context: 1, open_question: 1, action_item: 1, decision: 1, warning: 1 },
    cooldownMs: Infinity,
    perKindCooldownMs: Infinity,
  },
  quiet: {
    ambientEnabled: true,
    minConfidence: {
      context: 0.85,
      open_question: 0.75,
      action_item: 0.75,
      decision: 0.75,
      warning: 0.9,
    },
    cooldownMs: 90_000,
    perKindCooldownMs: 180_000,
  },
  balanced: {
    ambientEnabled: true,
    minConfidence: {
      context: 0.75,
      open_question: 0.7,
      action_item: 0.7,
      decision: 0.7,
      warning: WARNING_FLOOR,
    },
    cooldownMs: 45_000,
    perKindCooldownMs: 90_000,
  },
  active: {
    ambientEnabled: true,
    minConfidence: {
      context: 0.65,
      open_question: 0.6,
      action_item: 0.6,
      decision: 0.6,
      warning: WARNING_FLOOR,
    },
    cooldownMs: 20_000,
    perKindCooldownMs: 45_000,
  },
};
