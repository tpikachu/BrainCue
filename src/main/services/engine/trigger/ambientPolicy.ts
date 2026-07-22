import type { ContributionKind, Presence } from '@shared/types';
import {
  answersQuestion,
  evaluateTurnHeuristics,
  type HeuristicVerdict,
} from './meetingHeuristics';
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

/** How many substantive turns a raised question may go unaddressed before it
 *  becomes an open-question card. */
const OPEN_QUESTION_AFTER_TURNS = 2;
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
  private pendingQuestion: { text: string; title: string; turnsSince: number } | null = null;

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

    // A substantive turn advances (or resolves) any pending open question.
    // One decision per turn: a matured open question outranks the turn's own
    // signal (the un-answered question is the older debt).
    const matured = this.trackPendingQuestion(text, verdict);
    const prior = [...this.recent]; // classifier context = turns BEFORE this one
    this.remember(text);

    let candidate: Candidate;
    if (matured) {
      candidate = matured;
    } else if (verdict.type === 'action_item') {
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
      // Questions are HELD, not emitted — they only become open-question
      // cards if the conversation moves on without answering them.
      this.pendingQuestion = { text, title: verdict.title, turnsSince: 0 };
      return silent('question-held');
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
    if (now - this.lastEmitAt < cfg.cooldownMs) return silent('cooldown', c.usedClassifier);
    const lastKind = this.lastKindEmitAt.get(c.kind) ?? -Infinity;
    if (now - lastKind < cfg.perKindCooldownMs) return silent('kind-cooldown', c.usedClassifier);
    const key = `${c.kind}:${normalize(c.title)}`;
    if (this.seen.has(key)) return silent('duplicate', c.usedClassifier);

    this.seen.add(key);
    this.lastEmitAt = now;
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
    };
  }

  /** Advance the pending-question tracker with this substantive turn. Returns
   *  the matured open-question candidate when the question went unanswered
   *  long enough. */
  private trackPendingQuestion(text: string, verdict: HeuristicVerdict): Candidate | null {
    const pending = this.pendingQuestion;
    if (!pending || verdict.type === 'question') return null;
    if (answersQuestion(text, pending.text)) {
      this.pendingQuestion = null;
      return null;
    }
    pending.turnsSince += 1;
    if (pending.turnsSince < OPEN_QUESTION_AFTER_TURNS) return null;
    this.pendingQuestion = null;
    return {
      kind: 'open_question',
      title: pending.title,
      confidence: 0.8, // deterministic maturation, not a model score
      owner: null,
      deadline: null,
      usedClassifier: false,
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
