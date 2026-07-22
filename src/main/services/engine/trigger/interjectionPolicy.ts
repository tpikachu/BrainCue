import type { CompanionPresence, DndWindow } from '@shared/types';
import { evaluateTurnHeuristics } from './meetingHeuristics';
import {
  classifyCompanionSalience,
  type CompanionSalienceClassifier,
} from './companionSalience';
import {
  COMPANION_LEVELS,
  isCompanionPresence,
  type CompanionAmbientKind,
} from './companionPresence';
import type { CostMeter } from '../companion/costMeter';
import type { AmbientDecision } from './ambientPolicy';

/**
 * The Companion InterjectionPolicy engine: EVERY automatic contribution must
 * pass this deterministic gate chain — the LLM only ever scores salience, it
 * never decides to speak. Gate order is also cost order: everything cheap
 * (mute, presence, DND, budget, heuristics, global cooldown) runs BEFORE the
 * classifier, so silence, small talk, and cooldown windows never spend a
 * model call, and there is no periodic "thinking" loop — evaluation is
 * strictly turn-driven.
 *
 * Gates, in order:
 *   hard mute → presence → DND window → session budget → heuristic skip →
 *   global cooldown → [salience classifier] → user-speaking → confidence
 *   floor → relevance floor → per-kind cooldown → rolling rate cap → dedupe
 */

const silent = (reason: string, usedClassifier = false): AmbientDecision => ({
  act: false,
  kind: null,
  title: '',
  confidence: 0,
  owner: null,
  deadline: null,
  reason,
  usedClassifier,
});

/** Rolling turn window handed to the classifier for context. */
const RECENT_WINDOW = 6;

interface Candidate {
  kind: CompanionAmbientKind;
  title: string;
  confidence: number;
  relevance: number;
  usedClassifier: boolean;
}

export class InterjectionPolicy {
  private presence: CompanionPresence;
  private readonly dnd: DndWindow[];
  private readonly meter: CostMeter;
  private readonly classify: CompanionSalienceClassifier;
  private readonly clock: () => Date;
  private readonly onPresenceChange?: (p: CompanionPresence) => void;

  private lastEmitAt = -Infinity;
  private readonly lastKindEmitAt = new Map<CompanionAmbientKind, number>();
  private readonly seen = new Set<string>();
  private readonly recent: string[] = [];
  private readonly recentEmits: number[] = [];
  private lastInterimAt = -Infinity;
  private activeContext: string | null = null;

  constructor(opts: {
    presence: CompanionPresence;
    dnd?: DndWindow[];
    meter: CostMeter;
    classify?: CompanionSalienceClassifier;
    /** Injectable wall clock for the DND gate (tests pin exact times). */
    clock?: () => Date;
    onPresenceChange?: (p: CompanionPresence) => void;
  }) {
    this.presence = opts.presence;
    this.dnd = opts.dnd ?? [];
    this.meter = opts.meter;
    this.classify = opts.classify ?? classifyCompanionSalience;
    this.clock = opts.clock ?? (() => new Date());
    this.onPresenceChange = opts.onPresenceChange;
  }

  get currentPresence(): CompanionPresence {
    return this.presence;
  }

  /** Live posture change (AmbientPolicy contract — vocabulary validated here). */
  setPresence(presence: string): void {
    if (!isCompanionPresence(presence)) return;
    this.presence = presence;
    this.onPresenceChange?.(presence);
  }

  /** Interim transcript activity — the user is (still) speaking. */
  noteInterim(now: number): void {
    this.lastInterimAt = now;
  }

  /** The active-application/context seam ("when available"): a host that can
   *  report the focused app/document sets it here; it feeds the classifier.
   *  No OS integration ships yet — the seam and its gate are what's pinned. */
  setActiveContext(ctx: string | null): void {
    this.activeContext = ctx;
  }

  /** Evaluate one finalized turn. At most ONE decision per turn. */
  async evaluate(text: string, now: number): Promise<AmbientDecision> {
    const cfg = COMPANION_LEVELS[this.presence];
    if (this.presence === 'off') return silent('hard-mute');
    if (!cfg.ambientEnabled) return silent('summoned-only');
    if (this.inDnd()) return silent('dnd');
    if (this.meter.exhausted()) return silent('budget-exhausted');

    // Deterministic heuristics: greetings/filler/too-short turns are silence
    // and the classifier is NEVER called for them (silence costs nothing).
    const verdict = evaluateTurnHeuristics(text);
    if (verdict.type === 'skip') return silent(verdict.reason);

    const prior = [...this.recent]; // classifier context = turns BEFORE this one
    this.remember(text);

    // Global cooldown BEFORE the classifier — a cooldown window must not
    // spend model calls it can never act on.
    if (now - this.lastEmitAt < cfg.cooldownMs) return silent('cooldown');

    let candidate: Candidate;
    if (verdict.type === 'action_item') {
      candidate = {
        kind: 'action_item',
        title: verdict.title,
        confidence: verdict.confidence,
        relevance: 1, // the user's own explicit commitment — self-evidently theirs
        usedClassifier: false,
      };
    } else {
      // Ambiguous (incl. heuristic decisions/questions — companion has no
      // deterministic card for those): the classifier may score it.
      this.meter.noteCall('classify');
      const result = await this.classify(text, prior, this.activeContext);
      if (!result || !result.salient || !result.kind) return silent('not-salient', true);
      candidate = {
        kind: result.kind,
        title: result.title || text.slice(0, 160),
        confidence: result.confidence,
        relevance: result.relevance,
        usedClassifier: true,
      };
    }

    // The user started talking again while we were classifying — an
    // interjection now would land mid-sentence. Stay quiet.
    if (this.lastInterimAt > now) return silent('user-speaking', candidate.usedClassifier);

    return this.gate(candidate, cfg, now);
  }

  /** The deterministic tail gates: floors → per-kind cooldown → rate → dedupe. */
  private gate(
    c: Candidate,
    cfg: (typeof COMPANION_LEVELS)['assistive'],
    now: number,
  ): AmbientDecision {
    if (c.confidence < cfg.minConfidence[c.kind]) return silent('below-floor', c.usedClassifier);
    // Grounded kinds must actually tie to the user's material.
    if (
      (c.kind === 'memory_suggestion' || c.kind === 'context') &&
      c.relevance < cfg.minRelevance
    ) {
      return silent('below-relevance', c.usedClassifier);
    }
    const lastKind = this.lastKindEmitAt.get(c.kind) ?? -Infinity;
    if (now - lastKind < cfg.perKindCooldownMs) return silent('kind-cooldown', c.usedClassifier);
    const inWindow = this.recentEmits.filter((t) => now - t < cfg.recentWindowMs);
    if (inWindow.length >= cfg.maxRecent) return silent('rate-limited', c.usedClassifier);
    const key = `${c.kind}:${normalize(c.title)}`;
    if (this.seen.has(key)) return silent('duplicate', c.usedClassifier);

    this.seen.add(key);
    this.lastEmitAt = now;
    this.lastKindEmitAt.set(c.kind, now);
    this.recentEmits.push(now);
    return {
      act: true,
      kind: c.kind,
      title: c.title,
      confidence: c.confidence,
      owner: null, // companion cards never attribute owners/deadlines
      deadline: null,
      reason: 'emitted',
      usedClassifier: c.usedClassifier,
    };
  }

  /** Inside a do-not-disturb window? Windows are minutes-of-day; start > end
   *  spans midnight. */
  private inDnd(): boolean {
    if (this.dnd.length === 0) return false;
    const d = this.clock();
    const min = d.getHours() * 60 + d.getMinutes();
    return this.dnd.some((w) =>
      w.startMin <= w.endMin ? min >= w.startMin && min < w.endMin : min >= w.startMin || min < w.endMin,
    );
  }

  private remember(text: string): void {
    this.recent.push(text);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
