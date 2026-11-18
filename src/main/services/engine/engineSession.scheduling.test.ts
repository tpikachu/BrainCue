import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The interview scheduler wired into a real EngineSession (scripted mode,
 * fake persistence): what v1 got wrong, pinned end to end.
 *  - a question asked WHILE an answer streams is evaluated and answered next
 *    (v1 returned early and never evaluated it)
 *  - a split question re-answers the same card with the joined wording
 *  - questions waiting at Pause become visible "missed" cards
 *  - "Answer that" answers the interviewer's latest words on demand
 */

const h = vi.hoisted(() => ({
  questions: [] as { id: string; text: string }[],
  updated: [] as { id: string; text: string }[],
  opened: [] as string[],
  titles: [] as { id: string; title: string }[],
  metas: [] as { id: string; riskWarning: string | null }[],
  resets: [] as string[],
  generated: [] as string[],
  gate: null as null | { release: () => void; promise: Promise<void> },
}));

const openGate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  h.gate = { release, promise };
};

vi.mock('../../ipc/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../ipc/contributionBridge', () => ({
  emitAmbientContribution: vi.fn(),
  emitContributionContext: vi.fn(),
  emitContributionDelta: vi.fn(),
  emitContributionDone: vi.fn(),
  emitContributionFollowup: vi.fn(),
  emitContributionMeta: (id: string, m: { riskWarning: string | null }) => h.metas.push({ id, riskWarning: m.riskWarning }),
  emitContributionOpen: (p: { contributionId: string }) => h.opened.push(p.contributionId),
  emitContributionReset: (id: string) => h.resets.push(id),
  emitContributionTitle: (id: string, title: string) => h.titles.push({ id, title }),
}));
vi.mock('../../providers/normalizeError', () => ({ normalizeProviderError: (e: unknown) => String(e) }));
vi.mock('../../db/repositories/profiles.repo', () => ({
  profilesRepo: { get: () => ({ id: 'p1', name: 'Test User', language: 'en' }) },
}));
vi.mock('../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../memory/recall', () => ({ recallMemories: async () => [] }));
vi.mock('./grounding', () => ({ ground: async () => [] }));
vi.mock('./persistence/enginePersistence', () => {
  let tc = 0;
  return {
    enginePersistence: {
      finalTranscript: () => `tc${++tc}`,
      sessionRow: () => ({ id: 's1', profileId: 'p1', packId: null }),
      insertQuestion: (o: { text: string }) => {
        const id = `q${h.questions.length + 1}`;
        h.questions.push({ id, text: o.text });
        return id;
      },
      updateQuestionText: (id: string, text: string) => h.updated.push({ id, text }),
      replaceAnswer: vi.fn(),
      insertContribution: () => 'c1',
      setFollowup: vi.fn(),
      question: (id: string) => h.questions.find((q) => q.id === id) ?? null,
    },
  };
});

import { EngineSession } from './engineSession';
import { reactiveQuestionPolicy } from './trigger/reactiveQuestionPolicy';
import type { ModeDefinition } from './modeDefinition';

vi.mock('../openai/questions', () => ({
  classifyQuestion: async (text: string) => ({ isQuestion: false, text, type: 'followup', confidence: 0, strategy: '' }),
}));

const mode: ModeDefinition = {
  id: 'interview',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'interviewer',
  localSpeaker: 'candidate',
  trigger: reactiveQuestionPolicy,
  allowedContributions: ['answer'],
  surfaces: ['overlay'],
  defaultPresence: 'balanced',
  reportStrategy: 'interview_coaching',
  async *generate(input) {
    h.generated.push(input.question);
    if (h.gate) await h.gate.promise; // hold the stream "in flight"
    if (input.signal.aborted) throw new Error('aborted');
    yield { type: 'delta', token: 'A cue.' };
  },
};

function session(): EngineSession {
  return new EngineSession({
    sessionId: 's1',
    profileId: 'p1',
    packId: null,
    mode,
    settings: { interviewType: 'general', answerFormat: 'general', pronunciation: false, presence: 'balanced' },
    ephemeral: false,
  });
}

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000_000);
  for (const k of ['questions', 'updated', 'opened', 'titles', 'metas', 'resets', 'generated'] as const) h[k].length = 0;
  h.gate = null;
});
afterEach(() => vi.useRealTimers());

describe('EngineSession + scheduler', () => {
  it('a question asked while an answer streams is answered next, not lost', async () => {
    const s = session();
    openGate();
    void s.onTranscriptFinal('Tell me about yourself.');
    await tick();
    expect(s.answering).toBe(true);

    // The candidate answers, then the interviewer asks something new mid-stream.
    await s.onTranscriptFinal('Sure, I have been an engineer for eight years.', 'candidate');
    vi.advanceTimersByTime(10_000);
    void s.onTranscriptFinal('Why are you leaving your current role?');
    await tick();
    expect(h.generated).toEqual(['Tell me about yourself.']); // still one stream

    h.gate!.release();
    h.gate = null;
    await tick();
    await tick();
    expect(h.generated).toEqual(['Tell me about yourself.', 'Why are you leaving your current role?']);
    expect(h.questions.map((q) => q.text)).toEqual(['Tell me about yourself.', 'Why are you leaving your current role?']);
  });

  it('a split question re-answers the same card with the joined wording', async () => {
    const s = session();
    openGate();
    void s.onTranscriptFinal('Walk me through the payments migration.');
    await tick();
    void s.onTranscriptFinal('And what you would do differently.');
    await tick();
    h.gate!.release();
    h.gate = null;
    await tick();
    await tick();
    expect(h.questions).toHaveLength(1); // one row, one card
    expect(h.updated).toEqual([{ id: 'q1', text: 'Walk me through the payments migration. And what you would do differently.' }]);
    expect(h.titles).toEqual([{ id: 'q1', title: 'Walk me through the payments migration. And what you would do differently.' }]);
    expect(h.generated.at(-1)).toBe('Walk me through the payments migration. And what you would do differently.');
  });

  it('a microphone echo of the interviewer does not split their question', async () => {
    const s = session();
    openGate();
    void s.onTranscriptFinal('Walk me through the payments migration.');
    await tick();
    // Laptop speakers: the mic hears the call and transcribes the same words.
    void s.onTranscriptFinal('Walk me through the payments migration.', 'candidate');
    await vi.advanceTimersByTimeAsync(1600); // past the echo hold — dropped as an echo
    void s.onTranscriptFinal('And what you would do differently.');
    await tick();
    h.gate!.release();
    h.gate = null;
    await tick();
    await tick();
    expect(h.questions).toHaveLength(1); // still ONE card, re-answered with the joined wording
    expect(h.generated.at(-1)).toBe('Walk me through the payments migration. And what you would do differently.');
  });

  it('pause turns waiting questions into visible missed cards', async () => {
    const s = session();
    openGate();
    void s.onTranscriptFinal('Tell me about yourself.');
    await tick();
    await s.onTranscriptFinal('Happy to.', 'candidate');
    vi.advanceTimersByTime(10_000);
    void s.onTranscriptFinal('What is your notice period?');
    await tick();
    s.setPaused(true);
    // Not while the first answer streams — opening a card would collapse it.
    expect(h.questions.map((q) => q.text)).not.toContain('What is your notice period?');
    h.gate!.release();
    h.gate = null;
    await tick();
    await tick();
    expect(h.questions.map((q) => q.text)).toContain('What is your notice period?');
    expect(h.metas.find((m) => m.riskWarning?.includes('paused'))).toBeTruthy();
    // …and the streaming answer was never aborted by it.
    expect(h.generated).toEqual(['Tell me about yourself.']);
  });

  it('"Answer that" answers what the interviewer just said when detection missed it', async () => {
    const s = session();
    // Not decided by any rule, and the (mocked) classifier says no.
    await s.onTranscriptFinal('The thing with the queues last year.');
    expect(h.generated).toEqual([]);
    const r = await s.answerLastHeard();
    expect(r.ok).toBe(true);
    expect(h.generated).toEqual(['The thing with the queues last year.']);
  });

  it('the candidate’s own speech never creates a card', async () => {
    const s = session();
    await s.onTranscriptFinal('Tell me about the time I led the migration?', 'candidate');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.generated).toEqual([]);
  });
});
