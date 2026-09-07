import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';

/**
 * A session hears two streams: the call (the mode's remote speaker) and the
 * user's own microphone (the mode's local speaker). Both are transcribed and
 * kept — persisted, broadcast, remembered — but only the remote side can
 * trigger a cue: the user's own words are never a question to answer. This
 * drives EngineSession directly with a scripted mode, so the rule is pinned
 * independently of any provider.
 *
 * Own turns are HELD ~1.5 s before they are committed (echoGuard.ts: on
 * laptop speakers the mic hears the call, and the call's copy of the same
 * words drops the mic's). `settle()` runs that hold out under fake timers.
 */

const h = vi.hoisted(() => ({
  events: [] as { ch: string; payload: unknown }[],
  persisted: [] as { sessionId: string; speaker: string; text: string }[],
  generateInputs: [] as Record<string, unknown>[],
}));

vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, payload: unknown) => h.events.push({ ch, payload }),
}));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: vi.fn(),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: vi.fn(),
  emitContributionOpen: vi.fn(),
  emitContributionReset: vi.fn(),
}));
vi.mock('../../providers/normalizeError', () => ({ normalizeProviderError: (e: unknown) => String(e) }));
vi.mock('../../db/repositories/profiles.repo', () => ({
  profilesRepo: { get: () => ({ id: 'p1', name: 'Test User', language: 'en' }) },
}));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../memory/recall', () => ({ recallMemories: async () => [] }));
vi.mock('./grounding', () => ({ ground: async () => [] }));
vi.mock('./persistence/enginePersistence', () => ({
  enginePersistence: {
    finalTranscript: (sessionId: string, speaker: string, text: string) => {
      h.persisted.push({ sessionId, speaker, text });
      return `tc${h.persisted.length}`;
    },
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
    insertQuestion: () => 'q1',
    replaceAnswer: vi.fn(),
    insertContribution: () => 'c1',
    setFollowup: vi.fn(),
    questionText: () => null,
  },
}));

import { EngineSession } from './engineSession';
import { ECHO_HOLD_MS } from './echoGuard';
import type { ModeDefinition } from './modeDefinition';

const settle = () => vi.advanceTimersByTimeAsync(ECHO_HOLD_MS + 1);

const trigger = vi.fn(async () => ({
  act: true,
  kind: 'answer' as const,
  question: { type: 'behavioral', confidence: 0.9, strategy: '' },
  reason: 'question',
}));

/** An interview-shaped mode: legacy speaker pair, a scripted trigger, and a
 *  generator that records what history it was handed. */
const mode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: { evaluate: trigger },
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  async *generate(input) {
    h.generateInputs.push(input as unknown as Record<string, unknown>);
    yield { type: 'delta', token: 'A cue.' };
  },
};

function session(): EngineSession {
  return new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: null,
    mode,
    settings: { interviewType: 'general', answerFormat: 'key_points', pronunciation: false, presence: 'balanced' },
    ephemeral: false,
  });
}

const finals = () =>
  h.events
    .filter((e) => e.ch === EVENTS.transcriptDelta)
    .map((e) => e.payload as { text: string; speaker: string; isFinal: boolean });

beforeEach(() => {
  vi.useFakeTimers();
  h.events.length = 0;
  h.persisted.length = 0;
  h.generateInputs.length = 0;
  trigger.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('onTranscriptFinal — whose turn it is', () => {
  it("the user's own turn is persisted and broadcast with the local speaker, and never reaches the trigger", async () => {
    const s = session();
    await s.onTranscriptFinal('I led the migration to Postgres last year.', 'candidate');
    expect(h.persisted).toEqual([]); // held for the echo window first
    await settle();
    expect(h.persisted).toEqual([
      { sessionId: 's1', speaker: 'candidate', text: 'I led the migration to Postgres last year.' },
    ]);
    expect(finals()).toEqual([
      { text: 'I led the migration to Postgres last year.', speaker: 'candidate', isFinal: true },
    ]);
    expect(trigger).not.toHaveBeenCalled();
    expect(s.answering).toBe(false); // the answer slot was never claimed
  });

  it('a remote turn runs the trigger — and the speaker defaults to the remote one (v1 callers)', async () => {
    const s = session();
    await s.onTranscriptFinal('Tell me about a migration you led?');
    expect(h.persisted[0].speaker).toBe('interviewer');
    expect(trigger).toHaveBeenCalledWith('Tell me about a migration you led?');
    expect(h.generateInputs).toHaveLength(1);
  });

  it('an explicit remote speaker triggers exactly like the default', async () => {
    const s = session();
    await s.onTranscriptFinal('Why Postgres?', 'interviewer');
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("the user's own turns are remembered — labeled as theirs — so the next answer knows what they already said", async () => {
    const s = session();
    // The opener is not a question; the user's own turn never reaches the
    // trigger; the third turn is answered with both in its history.
    trigger.mockResolvedValueOnce({ act: false, kind: null, reason: 'not-a-question' } as never);
    await s.onTranscriptFinal('So, a few topics today.', 'interviewer');
    await s.onTranscriptFinal('I already covered the timeline in my intro.', 'candidate');
    await settle();
    expect(trigger).toHaveBeenCalledTimes(1);
    await s.onTranscriptFinal('What about the timeline?', 'interviewer');
    expect(h.generateInputs).toHaveLength(1);
    expect(h.generateInputs[0].history).toEqual([
      // Remote turns keep the v1 item shape (no speaker) — pinned by parity.
      { role: 'heard', text: 'So, a few topics today.' },
      { role: 'heard', text: 'I already covered the timeline in my intro.', speaker: 'candidate' },
    ]);
  });

  it('a local turn while an answer is streaming is still recorded and does not disturb the slot', async () => {
    const s = session();
    s.answering = true; // an answer is in flight
    await s.onTranscriptFinal('Right, so as I was saying…', 'candidate');
    await settle();
    expect(h.persisted).toHaveLength(1);
    expect(s.answering).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('a local turn under suppressed answering is not queued as the pending question', async () => {
    const s = session();
    s.suppressAnswers = true;
    await s.onTranscriptFinal('Let me think out loud for a second.', 'candidate');
    expect(s.pendingQuestionText).toBeNull();
    await s.onTranscriptFinal('Can you walk me through the tree?', 'interviewer');
    expect(s.pendingQuestionText).toBe('Can you walk me through the tree?');
  });

  it("the microphone's echo of the call is dropped, the user's real reply is kept", async () => {
    const s = session();
    trigger.mockResolvedValue({ act: false, kind: null, reason: 'not-a-question' } as never);
    // Laptop speakers: the call's turn comes back through the mic a moment later.
    await s.onTranscriptFinal('Marketing put it back.', 'interviewer');
    await vi.advanceTimersByTimeAsync(300);
    await s.onTranscriptFinal('Marketing put it back', 'candidate');
    await s.onTranscriptFinal('Right, I saw that this morning.', 'candidate');
    await settle();
    expect(h.persisted.map((p) => `${p.speaker}: ${p.text}`)).toEqual([
      'interviewer: Marketing put it back.',
      'candidate: Right, I saw that this morning.',
    ]);
    expect(finals().map((f) => f.speaker)).toEqual(['interviewer', 'candidate']);
  });

  it('the echo is dropped even when the microphone finals first', async () => {
    const s = session();
    trigger.mockResolvedValue({ act: false, kind: null, reason: 'not-a-question' } as never);
    await s.onTranscriptFinal('We have until the end of the month to confirm', 'candidate');
    await vi.advanceTimersByTimeAsync(500);
    await s.onTranscriptFinal('We have until the end of the month to confirm.', 'interviewer');
    await settle();
    expect(h.persisted).toEqual([
      { sessionId: 's1', speaker: 'interviewer', text: 'We have until the end of the month to confirm.' },
    ]);
  });

  it('teardown commits a held own turn instead of losing it', () => {
    const s = session();
    void s.onTranscriptFinal('That is all from me, thanks.', 'candidate');
    expect(h.persisted).toHaveLength(0);
    s.teardown();
    expect(h.persisted).toEqual([{ sessionId: 's1', speaker: 'candidate', text: 'That is all from me, thanks.' }]);
  });

  it('teardown stops every transcriber the session holds', () => {
    const s = session();
    const system = { appendAudio: vi.fn(), stop: vi.fn() };
    const mic = { appendAudio: vi.fn(), stop: vi.fn() };
    s.transcribers.system = system;
    s.transcribers.mic = mic;
    s.teardown();
    expect(system.stop).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(s.transcribers).toEqual({});
    s.teardown(); // idempotent
    expect(system.stop).toHaveBeenCalledTimes(1);
  });
});
