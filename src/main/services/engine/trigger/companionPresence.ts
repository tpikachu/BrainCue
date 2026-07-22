import type { CompanionPresence } from '@shared/types';

/** The ambient contribution kinds the companion may produce. */
export type CompanionAmbientKind =
  | 'memory_suggestion'
  | 'context'
  | 'action_item'
  | 'suggested_question';

/**
 * A companion presence level is EXPLICIT numbers, not a vibe — the same rule
 * as the meeting dial (trigger/presence.ts), with the additional gates the
 * InterjectionPolicy engine enforces: a relevance floor for grounded kinds,
 * and a rolling interjection rate cap.
 */
export interface InterjectionConfig {
  /** false = no automatic contributions (off = hard mute, on_demand = summon-only). */
  ambientEnabled: boolean;
  minConfidence: Record<CompanionAmbientKind, number>;
  /** Floor on the RELEVANCE score for grounded kinds (memory/context). */
  minRelevance: number;
  /** Minimum gap between ANY two interjections. */
  cooldownMs: number;
  /** Minimum gap between two interjections of the SAME kind. */
  perKindCooldownMs: number;
  /** At most this many interjections per rolling window. */
  maxRecent: number;
  recentWindowMs: number;
}

const NEVER: Record<CompanionAmbientKind, number> = {
  memory_suggestion: 1,
  context: 1,
  action_item: 1,
  suggested_question: 1,
};

export const COMPANION_LEVELS: Record<CompanionPresence, InterjectionConfig> = {
  off: {
    ambientEnabled: false,
    minConfidence: NEVER,
    minRelevance: 1,
    cooldownMs: Infinity,
    perKindCooldownMs: Infinity,
    maxRecent: 0,
    recentWindowMs: Infinity,
  },
  on_demand: {
    ambientEnabled: false,
    minConfidence: NEVER,
    minRelevance: 1,
    cooldownMs: Infinity,
    perKindCooldownMs: Infinity,
    maxRecent: 0,
    recentWindowMs: Infinity,
  },
  // Assistive: speaks up for clearly useful things, hates being noisy.
  assistive: {
    ambientEnabled: true,
    minConfidence: {
      memory_suggestion: 0.75,
      context: 0.8,
      action_item: 0.75,
      suggested_question: 0.85, // clarifying questions must EARN the interruption
    },
    minRelevance: 0.5,
    cooldownMs: 120_000,
    perKindCooldownMs: 240_000,
    maxRecent: 3,
    recentWindowMs: 10 * 60_000,
  },
  // Proactive: contributes whenever it plausibly helps.
  proactive: {
    ambientEnabled: true,
    minConfidence: {
      memory_suggestion: 0.65,
      context: 0.7,
      action_item: 0.65,
      suggested_question: 0.75,
    },
    minRelevance: 0.4,
    cooldownMs: 45_000,
    perKindCooldownMs: 90_000,
    maxRecent: 6,
    recentWindowMs: 10 * 60_000,
  },
};

export function isCompanionPresence(v: string): v is CompanionPresence {
  return v === 'off' || v === 'on_demand' || v === 'assistive' || v === 'proactive';
}
