import { EventEmitter } from 'node:events';
import { EVENTS } from '@shared/ipc';
import type {
  AnswerMetaEvent,
  ContextSentEvent,
  ContributionKind,
  RetrievedChunk,
} from '@shared/types';
import { broadcast } from './broadcast';

/**
 * Dual-emit bridge: every engine/solver output goes out as a generic
 * contribution event (the overlay's v2 card feed) AND as the legacy answer
 * event with its exact v1 payload. The legacy events are a compatibility
 * adapter — the dashboard still consumes them — and go away one release after
 * nothing subscribes. New emitters must call these, never the answer* events.
 */

type Targets = ('main' | 'overlay')[];

/** Main-process tap: mirrors every contribution open/delta/done INSIDE main,
 *  so output surfaces (the voice layer) can follow a stream without a second
 *  generation path or any change to what renderers receive. Fires AFTER the
 *  broadcast, with the generic payload. */
export const bridgeTap = new EventEmitter();
// Several subscribers (voice + future surfaces) may listen; silence the
// default 10-listener warning rather than sizing it speculatively.
bridgeTap.setMaxListeners(50);

export interface BridgeOpen {
  contributionId: string;
  kind: ContributionKind;
  title: string;
}

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
  bridgeTap.emit('open', { contributionId: p.contributionId, kind: p.kind, title: p.title });
}

export function emitContributionDelta(
  contributionId: string,
  token: string,
  targets?: Targets,
): void {
  broadcast(EVENTS.answerDelta, { questionId: contributionId, token }, targets);
  broadcast(EVENTS.contributionDelta, { contributionId, token }, targets);
  bridgeTap.emit('delta', { contributionId, token });
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
  bridgeTap.emit('done', { contributionId });
}

export function emitContributionReset(contributionId: string, targets?: Targets): void {
  broadcast(EVENTS.answerReset, { questionId: contributionId }, targets);
  broadcast(EVENTS.contributionReset, { contributionId }, targets);
}

/** One-shot GENERIC-ONLY emission for ambient cards (Meeting etc.): open →
 *  optional context patch → the whole body as one delta → done. No legacy
 *  answer-event twin — v1 subscribers never knew these kinds, and mirroring
 *  them as fake "questions" would corrupt the dashboard's Q&A surfaces. */
export function emitAmbientContribution(
  p: {
    contributionId: string;
    kind: ContributionKind;
    title: string;
    body: string;
    /** Retrieved grounding to surface in "data sent" (context cards). */
    contextChunks?: RetrievedChunk[];
  },
  targets: Targets = ['overlay'],
): void {
  broadcast(
    EVENTS.contributionOpen,
    { contributionId: p.contributionId, kind: p.kind, title: p.title },
    targets,
  );
  if (p.contextChunks) {
    const context: ContextSentEvent = {
      questionId: p.contributionId,
      question: p.title,
      chunks: p.contextChunks,
    };
    broadcast(EVENTS.contributionPatch, { contributionId: p.contributionId, context }, targets);
  }
  broadcast(
    EVENTS.contributionDelta,
    { contributionId: p.contributionId, token: p.body },
    targets,
  );
  broadcast(EVENTS.contributionDone, { contributionId: p.contributionId }, targets);
}

// --- Generic-only STREAMING emits (voice quick ask) --------------------------
// Like emitAmbientContribution these have no legacy answer-event twin (v1
// surfaces never knew these contributions, and mirroring them as fake
// "questions" would corrupt the dashboard's Q&A views) — but the body streams
// token-by-token instead of landing whole.

export function emitGenericOpen(
  p: { contributionId: string; kind: ContributionKind; title: string },
  targets: Targets = ['overlay'],
): void {
  broadcast(EVENTS.contributionOpen, p, targets);
  bridgeTap.emit('open', p);
}

export function emitGenericDelta(
  contributionId: string,
  token: string,
  targets: Targets = ['overlay'],
): void {
  broadcast(EVENTS.contributionDelta, { contributionId, token }, targets);
  bridgeTap.emit('delta', { contributionId, token });
}

export function emitGenericContext(
  contributionId: string,
  context: ContextSentEvent,
  targets: Targets = ['overlay'],
): void {
  broadcast(EVENTS.contributionPatch, { contributionId, context }, targets);
}

export function emitGenericDone(contributionId: string, targets: Targets = ['overlay']): void {
  broadcast(EVENTS.contributionDone, { contributionId }, targets);
  bridgeTap.emit('done', { contributionId });
}
