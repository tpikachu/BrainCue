import { EVENTS } from '@shared/ipc';
import type { AnswerMetaEvent, ContextSentEvent, ContributionKind } from '@shared/types';
import { broadcast } from './broadcast';

/**
 * Dual-emit bridge: every engine/solver output goes out as a generic
 * contribution event (the overlay's v2 card feed) AND as the legacy answer
 * event with its exact v1 payload. The legacy events are a compatibility
 * adapter — the dashboard still consumes them — and go away one release after
 * nothing subscribes. New emitters must call these, never the answer* events.
 */

type Targets = ('main' | 'overlay')[];

/** A new contribution began. `legacyExtra` = the extra fields this call site's
 *  v1 questionDetected payload carried (beyond id/text), reproduced verbatim. */
export function emitContributionOpen(
  p: {
    contributionId: string;
    kind: ContributionKind;
    title: string;
    legacyExtra?: Record<string, unknown>;
  },
  targets?: Targets,
): void {
  broadcast(
    EVENTS.questionDetected,
    { id: p.contributionId, text: p.title, ...(p.legacyExtra ?? {}) },
    targets,
  );
  broadcast(
    EVENTS.contributionOpen,
    { contributionId: p.contributionId, kind: p.kind, title: p.title },
    targets,
  );
}

export function emitContributionDelta(
  contributionId: string,
  token: string,
  targets?: Targets,
): void {
  broadcast(EVENTS.answerDelta, { questionId: contributionId, token }, targets);
  broadcast(EVENTS.contributionDelta, { contributionId, token }, targets);
}

/** `meta` is the legacy answerMeta payload verbatim (questionId + the stream's
 *  meta event fields) — both surfaces receive the same object. */
export function emitContributionMeta(
  contributionId: string,
  meta: AnswerMetaEvent,
  targets?: Targets,
): void {
  broadcast(EVENTS.answerMeta, meta, targets);
  broadcast(EVENTS.contributionPatch, { contributionId, meta }, targets);
}

export function emitContributionContext(
  contributionId: string,
  context: ContextSentEvent,
  targets?: Targets,
): void {
  broadcast(EVENTS.contextSent, context, targets);
  broadcast(EVENTS.contributionPatch, { contributionId, context }, targets);
}

export function emitContributionFollowup(
  contributionId: string,
  followup: string,
  targets?: Targets,
): void {
  broadcast(EVENTS.answerFollowup, { questionId: contributionId, followup }, targets);
  broadcast(EVENTS.contributionPatch, { contributionId, followup }, targets);
}

export function emitContributionDone(contributionId: string, targets?: Targets): void {
  broadcast(EVENTS.answerDone, { questionId: contributionId }, targets);
  broadcast(EVENTS.contributionDone, { contributionId }, targets);
}

export function emitContributionReset(contributionId: string, targets?: Targets): void {
  broadcast(EVENTS.answerReset, { questionId: contributionId }, targets);
  broadcast(EVENTS.contributionReset, { contributionId }, targets);
}
