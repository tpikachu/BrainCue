import type { ContributionKind, Presence } from '@shared/types';
import { evaluateTurnHeuristics } from './meetingHeuristics';
import { classifySalience, type SalienceClassifier } from './salience';
import { PRESENCE_LEVELS, WARNING_FLOOR, type AmbientKind } from './presence';

/**
 * The per-session ambient trigger: deterministic heuristics first, the
 * salience classifier only for ambiguous turns, then the deterministic gates
 * that ALWAYS wrap whatever a model said — per-kind confidence floors,
 * global + per-kind cooldowns, and duplicate suppression. The model may
 * score; code decides. Silence is the default outcome, never the exception.
 */

export interface AmbientDecision {
  act: boolean;
  /** The card kind to build (meeting emits AmbientKind values; companion adds
   *  memory_suggestion/suggested_question — buildCard owns the mapping). */
  kind: ContributionKind | null;
  title: string;
  confidence: number;
  owner: string | null;
  deadline: string | null;
  /** Why (for logs/tests): 'greeting', 'cooldown', 'duplicate', 'below-floor', … */
  reason: string;
  usedClassifier: boolean;
  /** A question asked in the room at a presence that answers questions: the
   *  engine streams a grounded answer instead of building a card. */
  answer?: boolean;
}

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
  kind: AmbientKind;
  title: string;
  confidence: number;
  owner: string | null;
  deadline: string | null;
  usedClassifier: boolean;
}

export class AmbientTriggerPolicy {
  private presence: Presence;
  private readonly classify: SalienceClassifier;
  private lastEmitAt = -Infinity;
  private readonly lastKindEmitAt = new Map<AmbientKind, number>();
  private readonly seen = new Set<string>();
  private readonly recent: string[] = [];

  constructor(presence: Presence, classify: SalienceClassifier = classifySalience) {
    this.presence = presence;
    this.classify = classify;
  }

  setPresence(p: Presence): void {
    this.presence = p;
  }

  /** Evaluate one finalized turn. `now` comes from the caller so the cooldown
   *  clock is testable. At most ONE decision per turn. */
  async evaluate(text: string, now: number): Promise<AmbientDecision> {
    const cfg = PRESENCE_LEVELS[this.presence];
    if (!cfg.ambientEnabled) return silent('summoned-only');

    const verdict = evaluateTurnHeuristics(text);
    if (verdict.type === 'skip') return silent(verdict.reason); // classifier never called

    const prior = [...this.recent]; // classifier context = turns BEFORE this one
    this.remember(text);

    let candidate: Candidate;
    if (verdict.type === 'action_item') {
      candidate = {
        kind: 'action_item',
        title: verdict.title,
        confidence: verdict.confidence,
        owner: null, // heuristics never attribute owners
        deadline: verdict.deadline,
        usedClassifier: false,
      };
    } else if (verdict.type === 'decision') {
      candidate = {
        kind: 'decision',
        title: verdict.title,
        confidence: verdict.confidence,
        owner: null,
        deadline: null,
        usedClassifier: false,
      };
    } else if (verdict.type === 'question') {
      // A question asked in the room is the highest-value moment this trigger
      // sees, so it is acted on NOW: a card at quiet, a streamed grounded
      // answer at balanced/active (the engine reads `answer`). It used to be
      // held for two turns and dropped the moment any later turn shared a
      // word with it — which in a real meeting meant never.
      candidate = {
        kind: 'open_question',
        title: verdict.title,
        confidence: verdict.confidence,
        owner: null,
        deadline: null,
        usedClassifier: false,
      };
    } else {
      // Ambiguous → the classifier may score it; code still decides below.
      const result = await this.classify(text, prior);
      if (!result || !result.salient || !result.kind) return silent('not-salient', true);
      candidate = {
        kind: result.kind,
        title: result.title || text.slice(0, 160),
        confidence: result.confidence,
        owner: result.owner,
        deadline: result.deadline,
        usedClassifier: true,
      };
    }

    return this.gate(candidate, cfg, now);
  }

  /** The deterministic gates every candidate passes: floors → cooldowns → dedupe. */
  private gate(
    c: Candidate,
    cfg: (typeof PRESENCE_LEVELS)['quiet'],
    now: number,
  ): AmbientDecision {
    const floor = c.kind === 'warning' ? Math.max(cfg.minConfidence.warning, WARNING_FLOOR) : cfg.minConfidence[c.kind];
    if (c.confidence < floor) return silent('below-floor', c.usedClassifier);
    // Questions skip the cooldowns: the room does not pace its questions to our
    // card cadence, and a missed one is exactly the failure users report. The
    // duplicate filter still applies — the same question twice is one card.
    const isQuestion = c.kind === 'open_question';
    if (!isQuestion) {
      if (now - this.lastEmitAt < cfg.cooldownMs) return silent('cooldown', c.usedClassifier);
      const lastKind = this.lastKindEmitAt.get(c.kind) ?? -Infinity;
      if (now - lastKind < cfg.perKindCooldownMs) return silent('kind-cooldown', c.usedClassifier);
    }
    const key = `${c.kind}:${normalize(c.title)}`;
    if (this.seen.has(key)) return silent('duplicate', c.usedClassifier);

    this.seen.add(key);
    // A question must not push back the next action item or decision either.
    if (!isQuestion) this.lastEmitAt = now;
    this.lastKindEmitAt.set(c.kind, now);
    return {
      act: true,
      kind: c.kind,
      title: c.title,
      confidence: c.confidence,
      owner: c.owner,
      deadline: c.deadline,
      reason: 'emitted',
      usedClassifier: c.usedClassifier,
      answer: isQuestion && cfg.answerQuestions,
    };
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
