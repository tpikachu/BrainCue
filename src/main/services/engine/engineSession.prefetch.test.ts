import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Grounding starts on the INTERIM transcript, while the speaker is still
 * finishing the question, so the embedding round trip is not paid after the
 * endpoint has already waited for silence. The final that says the same
 * words reuses it; a different final grounds afresh.
 */
const h = vi.hoisted(() => ({
  groundCalls: [] as string[],
  generateInputs: [] as { contextChunks: unknown[] }[],
}));

vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
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
vi.mock('./grounding', () => ({
  ground: async (_profileId: string, query: string) => {
    h.groundCalls.push(query);
    return [{ id: `chunk-for:${query}`, content: query, sourceType: 'notes', score: 1 }];
  },
}));
vi.mock('./persistence/enginePersistence', () => ({
  enginePersistence: {
    finalTranscript: () => 'tc1',
    sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
    insertQuestion: () => 'q1',
    replaceAnswer: vi.fn(),
    insertContribution: () => 'c1',
    setFollowup: vi.fn(),
    questionText: () => null,
  },
}));

import { EngineSession } from './engineSession';
import type { ModeDefinition } from './modeDefinition';

const mode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: {
    evaluate: async () => ({ act: true, kind: 'answer' as const, question: { type: 'behavioral', confidence: 0.9, strategy: '' }, reason: 'q' }),
  },
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  async *generate(input) {
    h.generateInputs.push({ contextChunks: input.contextChunks });
    yield { type: 'delta', token: 'A cue.' };
  },
};

const session = () =>
  new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: null,
    mode,
    settings: { interviewType: 'general', answerFormat: 'key_points', pronunciation: false, presence: 'balanced' },
    ephemeral: false,
  });

beforeEach(() => {
  h.groundCalls.length = 0;
  h.generateInputs.length = 0;
});

describe('prefetchGrounding', () => {
  it('starts grounding once the interim reads as a question, and the matching final reuses it', async () => {
    const s = session();
    s.prefetchGrounding('What is');
    s.prefetchGrounding('What is our');
    expect(h.groundCalls).toEqual([]); // too short to be a question yet
    s.prefetchGrounding('What is our budget for');
    s.prefetchGrounding('What is our budget for the');
    expect(h.groundCalls).toEqual(['What is our budget for']); // one prefetch per turn
    await s.onTranscriptFinal('What is our budget for the third quarter?');
    expect(h.groundCalls).toHaveLength(1); // no second embedding on the final
    expect(h.generateInputs[0].contextChunks).toEqual([
      expect.objectContaining({ id: 'chunk-for:What is our budget for' }),
    ]);
  });

  it('refreshes the prefetch when the turn has grown by half again', () => {
    const s = session();
    s.prefetchGrounding('Can you walk me through');
    s.prefetchGrounding('Can you walk me through the migration');
    s.prefetchGrounding('Can you walk me through the migration you led at the bank last year');
    expect(h.groundCalls).toEqual([
      'Can you walk me through',
      'Can you walk me through the migration you led at the bank last year',
    ]);
  });

  it('a final that says something else grounds afresh, and the stale prefetch is dropped', async () => {
    const s = session();
    s.prefetchGrounding('What is our budget for the campaign');
    await s.onTranscriptFinal('Is the vendor contract signed yet?');
    expect(h.groundCalls).toEqual(['What is our budget for the campaign', 'Is the vendor contract signed yet?']);
    expect(h.generateInputs[0].contextChunks[0]).toMatchObject({ id: 'chunk-for:Is the vendor contract signed yet?' });
    // Consumed: the next final does not see the old prefetch either.
    await s.onTranscriptFinal('What is our budget for the campaign?');
    expect(h.groundCalls).toHaveLength(3);
  });

  it('statements never prefetch', () => {
    const s = session();
    s.prefetchGrounding('We shipped the new onboarding flow last Tuesday and it went fine');
    expect(h.groundCalls).toEqual([]);
  });
});
