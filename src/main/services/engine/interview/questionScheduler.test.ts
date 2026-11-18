import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectQuestion } from './detector';
import {
  CONTINUATION_WINDOW_MS,
  FRAGMENT_HOLD_MS,
  QUEUE_MAX,
  QuestionScheduler,
  type QuestionJob,
  type SchedulerDeps,
} from './questionScheduler';

vi.mock('../../openai/questions', () => ({ classifyQuestion: vi.fn() }));

/** A fake session: answers stream until released (or aborted), so a test
 *  can hold one answer "streaming" and ask more questions meanwhile. */
function harness(opts: { classifierSays?: boolean } = {}) {
  const answered: { seq: number; text: string; questionId: string }[] = [];
  const missed: { text: string; why: string }[] = [];
  const decisions: string[] = [];
  let release: (() => void) | null = null;
  let busy = false;
  let qid = 0;
  const deps: SchedulerDeps = {
    detect: (text, recent) =>
      detectQuestion(text, {
        recent,
        classify: async (t) => ({
          isQuestion: opts.classifierSays ?? false,
          text: t,
          type: 'followup',
          confidence: 0.9,
          strategy: '',
        }),
      }),
    recent: () => [],
    answer: (job: QuestionJob) => {
      job.questionId ??= `q${++qid}`;
      answered.push({ seq: job.seq, text: job.text, questionId: job.questionId });
      busy = true;
      return new Promise<void>((resolve) => {
        release = () => {
          busy = false;
          release = null;
          resolve();
        };
      });
    },
    abortActive: () => release?.(),
    slotBusy: () => busy,
    missed: (job, why) => missed.push({ text: job.text, why }),
    onDecision: (d) => decisions.push(d.outcome),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const s = new QuestionScheduler(deps);
  /** Let the answer that is streaming finish. */
  const finish = async () => {
    release?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { s, answered, missed, decisions, finish, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('QuestionScheduler — detection keeps running while an answer streams', () => {
  it('a second question during a streaming answer is queued, then answered (not dropped)', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about yourself.', 't1');
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual(['Tell me about yourself.']);

    vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1); // a new, distinct question
    h.s.onCandidateTurn();
    void h.s.onRemoteFinal('Why did you leave your last job?', 't2');
    await settle();
    expect(h.answered).toHaveLength(1); // still streaming the first
    expect(h.s.pending.map((j) => j.text)).toEqual(['Why did you leave your last job?']);

    await h.finish();
    expect(h.answered.map((a) => a.text)).toEqual(['Tell me about yourself.', 'Why did you leave your last job?']);
  });

  it('queued questions keep their order and a full queue surfaces missed cards', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about yourself.', 't0');
    await settle();
    const qs = ['What is a mutex?', 'How does TCP handshake work?', 'Why use Kafka?', 'What is CAP theorem?', 'Explain eventual consistency.'];
    for (const [i, q] of qs.entries()) {
      vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1);
      h.s.onCandidateTurn();
      void h.s.onRemoteFinal(q, `t${i + 1}`);
      await settle();
    }
    expect(h.s.pending).toHaveLength(QUEUE_MAX);
    expect(h.missed.map((m) => m.text)).toEqual(qs.slice(0, qs.length - QUEUE_MAX));
    expect(h.missed.every((m) => m.why === 'queue-full')).toBe(true);
  });

  it('waits for a manual Ask holding the slot, then answers', async () => {
    const h = harness();
    let manualBusy = true;
    const slotBusy = h.deps.slotBusy;
    h.deps.slotBusy = () => manualBusy || slotBusy();
    void h.s.onRemoteFinal('Walk me through that project.', 't1');
    await settle();
    expect(h.answered).toHaveLength(0);
    manualBusy = false;
    h.s.slotFreed();
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual(['Walk me through that project.']);
  });
});

describe('QuestionScheduler — duplicates, revisions, continuations, corrections', () => {
  it('a repeated final does not answer twice', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about the migration you led.', 't1');
    await settle();
    void h.s.onRemoteFinal('Tell me about the migration you led', 't2');
    await settle();
    expect(h.answered).toHaveLength(1);
    expect(h.decisions).toContain('duplicate');
  });

  it('the same question asked again after the candidate answered is answered again', async () => {
    const h = harness();
    void h.s.onRemoteFinal('What is your biggest weakness?', 't1');
    await settle();
    await h.finish();
    vi.advanceTimersByTime(5000);
    h.s.onCandidateTurn();
    vi.advanceTimersByTime(1000);
    void h.s.onRemoteFinal('What is your biggest weakness?', 't2');
    await settle();
    expect(h.answered).toHaveLength(2);
  });

  it('a split question is joined: the continuation supersedes the same card', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about the payments migration.', 't1');
    await settle();
    vi.advanceTimersByTime(1500);
    void h.s.onRemoteFinal('And how you tested it.', 't2');
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual([
      'Tell me about the payments migration.',
      'Tell me about the payments migration. And how you tested it.',
    ]);
    // Same card, re-answered — not a second card.
    expect(new Set(h.answered.map((a) => a.questionId)).size).toBe(1);
    expect(h.decisions).toContain('superseded');
  });

  it('a correction supersedes the stale answer', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about your first project at Acme.', 't1');
    await settle();
    void h.s.onRemoteFinal('Sorry, I meant the second project.', 't2');
    await settle();
    expect(h.answered).toHaveLength(2);
    expect(h.answered[1].text).toMatch(/Sorry, I meant the second project\.$/);
    expect(h.answered[1].questionId).toBe(h.answered[0].questionId);
  });

  it('after the candidate starts answering, the next question is new, not a continuation', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about the migration.', 't1');
    await settle();
    await h.finish();
    h.s.onCandidateTurn(Date.now() + 1);
    vi.advanceTimersByTime(2000);
    void h.s.onRemoteFinal('And what was your role?', 't2');
    await settle();
    expect(h.answered).toHaveLength(2);
    expect(h.answered[1].text).toBe('And what was your role?');
    expect(h.answered[1].questionId).not.toBe(h.answered[0].questionId);
  });

  it('a longer revision of a queued question replaces its text', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about yourself.', 't0');
    await settle();
    vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1);
    h.s.onCandidateTurn();
    void h.s.onRemoteFinal('How do you handle conflict on a team?', 't1');
    await settle();
    void h.s.onRemoteFinal('How do you handle conflict on a team you lead?', 't2');
    await settle();
    expect(h.s.pending.map((j) => j.text)).toEqual(['How do you handle conflict on a team you lead?']);
  });
});

describe('QuestionScheduler — fragments and interim safety', () => {
  it('a dangling fragment waits for its second half and joins it', async () => {
    const h = harness();
    void h.s.onRemoteFinal('So walk me through the', 't1');
    await settle();
    expect(h.answered).toHaveLength(0);
    vi.advanceTimersByTime(600);
    void h.s.onRemoteFinal('migration you led at Stripe.', 't2');
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual(['So walk me through the migration you led at Stripe.']);
  });

  it('a fragment with no second half is evaluated after the hold', async () => {
    const h = harness({ classifierSays: true });
    void h.s.onRemoteFinal('Tell me about your experience with', 't1');
    await vi.advanceTimersByTimeAsync(FRAGMENT_HOLD_MS + 1);
    expect(h.answered).toHaveLength(1);
  });

  it('backchannel never creates a card', async () => {
    const h = harness({ classifierSays: true });
    for (const t of ['Okay.', 'Mm-hmm.', 'Great, thanks.']) void h.s.onRemoteFinal(t, t);
    await settle();
    expect(h.answered).toHaveLength(0);
  });
});

describe('QuestionScheduler — late classifier verdicts', () => {
  const lateYes = (h: ReturnType<typeof harness>, ms: number) => {
    h.deps.detect = (text) =>
      detectQuestion(text, {
        timeoutMs: 1200,
        classify: (t) =>
          new Promise((r) => setTimeout(() => r({ isQuestion: true, text: t, type: 'followup', confidence: 0.9, strategy: '' }), ms)),
      });
  };

  it('a slow classifier "yes" still answers the question', async () => {
    const h = harness();
    lateYes(h, 2500);
    void h.s.onRemoteFinal('Say more about the ranking change.', 't1');
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.answered).toHaveLength(0); // fallback said no at the timeout
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.answered.map((a) => a.text)).toEqual(['Say more about the ranking change.']);
  });

  it('a late "yes" is dropped once the candidate has started responding', async () => {
    const h = harness();
    lateYes(h, 3000);
    void h.s.onRemoteFinal('Say more about the ranking change.', 't1');
    await vi.advanceTimersByTimeAsync(2000);
    h.s.onCandidateTurn();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.answered).toHaveLength(0);
    expect(h.decisions).toContain('stale');
  });
});

describe('QuestionScheduler — pause, stop, stale work', () => {
  it('pause turns waiting questions into missed cards; stop drops everything', async () => {
    const h = harness();
    void h.s.onRemoteFinal('Tell me about yourself.', 't0');
    await settle();
    vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1);
    h.s.onCandidateTurn();
    void h.s.onRemoteFinal('Why this company?', 't1');
    await settle();
    h.s.pause();
    expect(h.missed).toEqual([{ text: 'Why this company?', why: 'paused' }]);
    void h.s.onRemoteFinal('What is your notice period?', 't2'); // ignored while paused
    await settle();
    expect(h.s.pending).toHaveLength(0);
    h.s.stop();
    await h.finish();
    expect(h.answered).toHaveLength(1);
  });

  it('a classification that resolves after stop does not answer', async () => {
    const h = harness();
    let resolveClassify!: (v: boolean) => void;
    h.deps.detect = (text) =>
      detectQuestion(text, {
        classify: (t) =>
          new Promise((r) => {
            resolveClassify = (v) => r({ isQuestion: v, text: t, type: 'followup', confidence: 0.9, strategy: '' });
          }),
      });
    void h.s.onRemoteFinal('The scaling side', 't1');
    await settle();
    h.s.stop();
    resolveClassify(true);
    await settle();
    expect(h.answered).toHaveLength(0);
    expect(h.decisions).toContain('stale');
  });
});
