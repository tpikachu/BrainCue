import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';

/**
 * The compatibility contract: every bridge emit produces BOTH the legacy
 * answer event with its exact v1 payload (the dashboard still consumes those)
 * AND the generic contribution twin, to the same targets. If a payload here
 * drifts, a v1 subscriber breaks — change the adapter, not the contract.
 */

const h = vi.hoisted(() => ({
  calls: [] as { ch: string; payload: unknown; targets: unknown }[],
}));

vi.mock('./broadcast', () => ({
  broadcast: (ch: string, payload: unknown, targets?: unknown) =>
    h.calls.push({ ch, payload, targets }),
}));

import {
  emitContributionContext,
  emitContributionDelta,
  emitContributionDone,
  emitContributionFollowup,
  emitContributionMeta,
  emitContributionOpen,
  emitContributionReset,
} from './contributionBridge';

beforeEach(() => {
  h.calls.length = 0;
});

describe('emitContributionOpen', () => {
  it('legacy questionDetected keeps the v1 payload shape (id/text + site extras)', () => {
    emitContributionOpen({
      contributionId: 'q1',
      kind: 'answer',
      title: 'Why hashmaps?',
      legacyExtra: { sessionId: 's1', type: 'technical', confidence: 0.9, strategy: '' },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toMatchObject({
      ch: EVENTS.questionDetected,
      payload: { id: 'q1', text: 'Why hashmaps?', sessionId: 's1', type: 'technical' },
    });
    expect(h.calls[1]).toEqual({
      ch: EVENTS.contributionOpen,
      payload: { contributionId: 'q1', kind: 'answer', title: 'Why hashmaps?' },
      targets: undefined,
    });
  });

  it('forwards targets to BOTH events (coding solves are overlay-only)', () => {
    emitContributionOpen(
      { contributionId: 'q2', kind: 'code', title: 'Coding problem', legacyExtra: { type: 'coding' } },
      ['overlay'],
    );
    expect(h.calls.map((c) => c.targets)).toEqual([['overlay'], ['overlay']]);
    expect(h.calls[0].payload).toEqual({ id: 'q2', text: 'Coding problem', type: 'coding' });
  });
});

describe('stream + annotation emits', () => {
  it('delta: legacy {questionId, token} + generic {contributionId, token}', () => {
    emitContributionDelta('q1', 'Hel');
    expect(h.calls[0]).toMatchObject({
      ch: EVENTS.answerDelta,
      payload: { questionId: 'q1', token: 'Hel' },
    });
    expect(h.calls[1]).toMatchObject({
      ch: EVENTS.contributionDelta,
      payload: { contributionId: 'q1', token: 'Hel' },
    });
  });

  it('meta: the SAME v1 payload goes to both surfaces (patch wraps it)', () => {
    const meta = { questionId: 'q1', riskWarning: 'careful' };
    emitContributionMeta('q1', meta);
    expect(h.calls[0]).toMatchObject({ ch: EVENTS.answerMeta, payload: meta });
    expect(h.calls[1]).toMatchObject({
      ch: EVENTS.contributionPatch,
      payload: { contributionId: 'q1', meta },
    });
  });

  it('context: legacy contextSent payload verbatim + patch twin', () => {
    const context = { questionId: 'q1', question: 'Q?', chunks: [] };
    emitContributionContext('q1', context);
    expect(h.calls[0]).toMatchObject({ ch: EVENTS.contextSent, payload: context });
    expect(h.calls[1]).toMatchObject({
      ch: EVENTS.contributionPatch,
      payload: { contributionId: 'q1', context },
    });
  });

  it('followup / done / reset all pair legacy + generic', () => {
    emitContributionFollowup('q1', 'And then?', ['overlay']);
    emitContributionDone('q1');
    emitContributionReset('q1');
    expect(h.calls.map((c) => c.ch)).toEqual([
      EVENTS.answerFollowup,
      EVENTS.contributionPatch,
      EVENTS.answerDone,
      EVENTS.contributionDone,
      EVENTS.answerReset,
      EVENTS.contributionReset,
    ]);
    expect(h.calls[0].payload).toEqual({ questionId: 'q1', followup: 'And then?' });
    expect(h.calls[1].payload).toEqual({ contributionId: 'q1', followup: 'And then?' });
    expect(h.calls[2].payload).toEqual({ questionId: 'q1' });
    expect(h.calls[3].payload).toEqual({ contributionId: 'q1' });
    expect(h.calls[4].payload).toEqual({ questionId: 'q1' });
    expect(h.calls[5].payload).toEqual({ contributionId: 'q1' });
  });
});
