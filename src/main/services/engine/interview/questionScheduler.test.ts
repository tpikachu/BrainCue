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

  it('a late "yes" after the candidate started replying is not answered — it becomes a visible missed card (M3)', async () => {
    const h = harness();
    lateYes(h, 3000);
    void h.s.onRemoteFinal('Say more about the ranking change.', 't1');
    await vi.advanceTimersByTimeAsync(2000);
    h.s.onCandidateTurn();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.answered).toHaveLength(0);
    expect(h.missed).toEqual([{ text: 'Say more about the ranking change.', why: 'late' }]);
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

describe('QuestionScheduler — decisions commit in arrival order (review finding)', () => {
  const yes = (over: Partial<import('./detector').Detection> = {}): import('./detector').Detection => ({
    act: true,
    type: 'followup',
    confidence: 0.9,
    strategy: '',
    source: 'model',
    reason: 'model-yes',
    continuesPrevious: false,
    ...over,
  });

  /** A harness whose detection takes a scripted time per utterance. */
  function timed(delays: Record<string, number>, verdict: (t: string) => import('./detector').Detection = () => yes()) {
    const h = harness();
    let calls = 0;
    h.deps.detect = (text) => {
      calls++;
      return new Promise((r) => setTimeout(() => r(verdict(text)), delays[text] ?? 0));
    };
    return { ...h, calls: () => calls };
  }

  it('an earlier, slowly classified question is answered BEFORE a later, quickly classified one', async () => {
    const h = timed({ 'The thing with the queues last year.': 1000, 'Why did you leave Acme?': 10 });
    void h.s.onRemoteFinal('The thing with the queues last year.', 't1');
    vi.advanceTimersByTime(50);
    void h.s.onRemoteFinal('Why did you leave Acme?', 't2');
    await vi.advanceTimersByTimeAsync(100);
    // The later one is decided, but must not jump the earlier one.
    expect(h.answered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.answered.map((a) => a.text)).toEqual(['The thing with the queues last year.']);
    await h.finish();
    expect(h.answered.map((a) => a.text)).toEqual(['The thing with the queues last year.', 'Why did you leave Acme?']);
  });

  it('two copies of one question classified concurrently become ONE card', async () => {
    const q = 'The thing with the queues last year.';
    const h = timed({ [q]: 500 });
    void h.s.onRemoteFinal(q, 't1');
    vi.advanceTimersByTime(100);
    void h.s.onRemoteFinal(q, 't2'); // a duplicate final, while the first is still classifying
    await vi.advanceTimersByTimeAsync(1000);
    await h.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.answered.map((a) => a.text)).toEqual([q]);
    expect(h.decisions).toContain('duplicate');
  });

  it('a late "yes" for a question meanwhile asked again and answered is not answered twice', async () => {
    const q = 'The thing with the queues last year.';
    let resolveLate!: (d: import('./detector').Detection) => void;
    const h = timed({}, (t) =>
      t === q && !resolveLate
        ? yes({ act: false, source: 'fallback', reason: 'timeout', late: new Promise((r) => (resolveLate = r)) })
        : yes(),
    );
    void h.s.onRemoteFinal(q, 't1');
    await settle();
    expect(h.answered).toHaveLength(0); // timed out, fallback said no
    void h.s.onRemoteFinal(q, 't2'); // asked again; this time the classifier answers in time
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual([q]);
    resolveLate(yes());
    await settle();
    await h.finish();
    await settle();
    expect(h.answered.map((a) => a.text)).toEqual([q]);
  });
});

/**
 * M3 acceptance — every scenario under CONTROLLED timing: each utterance's
 * detection is scripted (delay + verdict) on fake timers, so interleavings
 * are exact and repeatable. Policy under test: questionScheduler.ts §1–§8.
 */
describe('M3 acceptance — questions answered in the right order', () => {
  type D = import('./detector').Detection;
  const verdict = (act: boolean, over: Partial<D> = {}): D => ({
    act,
    type: 'followup',
    confidence: 0.9,
    strategy: '',
    source: 'model',
    reason: act ? 'model-yes' : 'model-no',
    continuesPrevious: false,
    ...over,
  });

  /** Detection per utterance: [delayMs, verdict]. Unscripted: rules decide
   *  instantly (the real detector, whose classifier answers "no"). Records
   *  every detection call. */
  function scripted(script: Record<string, [number, D]>) {
    const h = harness();
    const calls: string[] = [];
    h.deps.detect = (text, recent) => {
      calls.push(text);
      const s = script[text];
      if (!s)
        return detectQuestion(text, {
          recent,
          classify: async (t) => ({ isQuestion: false, text: t, type: 'followup', confidence: 0, strategy: '' }),
        });
      return new Promise((r) => setTimeout(() => r(s[1]), s[0]));
    };
    return { ...h, calls };
  }
  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const texts = (h: { answered: { text: string }[] }) => h.answered.map((a) => a.text);
  const late = (): { d: D; resolve: (d: D) => void } => {
    let resolve!: (d: D) => void;
    const p = new Promise<D>((r) => (resolve = r));
    return { d: verdict(false, { source: 'fallback', reason: 'timeout', late: p }), resolve };
  };

  // ---- arrival order ----
  it('earlier SLOW classification, later FAST one: answered in arrival order; detection never paused', async () => {
    const A = 'The thing with the queues last year.';
    const B = 'Why did you leave Acme?'; // decided by rule in 0 ms
    const h = scripted({ [A]: [1000, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(50);
    void h.s.onRemoteFinal(B, 't2');
    await run(100);
    expect(h.calls).toEqual([A, B]); // both detected concurrently
    expect(h.answered).toHaveLength(0); // B waits for A's decision
    await run(1000);
    expect(texts(h)).toEqual([A]);
    await h.finish();
    expect(texts(h)).toEqual([A, B]);
  });

  it('earlier slow "NO", later fast question: the later one is still answered (never lost)', async () => {
    const A = 'We use Kafka quite a lot here.';
    const B = 'How would you scale the ingest?';
    const h = scripted({ [A]: [1000, verdict(false)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    void h.s.onRemoteFinal(B, 't2');
    await run(1100);
    expect(texts(h)).toEqual([B]);
  });

  // ---- duplicates ----
  it('duplicate finals while BOTH classifications are in flight: one card', async () => {
    const A = 'The thing with the queues last year.';
    const h = scripted({ [A]: [600, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(100);
    void h.s.onRemoteFinal(A, 't2');
    await run(1000);
    await h.finish();
    await run(100);
    expect(texts(h)).toEqual([A]);
    expect(h.decisions).toContain('duplicate');
  });

  it('a longer revision while the first is still classifying: one card, the longer wording', async () => {
    const A = 'The thing with the queues';
    const A2 = 'The thing with the queues last year.';
    const h = scripted({ [A]: [600, verdict(true)], [A2]: [100, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(50);
    void h.s.onRemoteFinal(A2, 't2');
    await run(1000);
    expect(new Set(h.answered.map((a) => a.questionId)).size).toBe(1); // same card, re-answered
    expect(texts(h).at(-1)).toBe(A2);
  });

  // ---- split questions and corrections ----
  it('a continuation arriving while the first half is still classifying joins it — one card', async () => {
    const A = 'Walk me through the payments migration.';
    const C = 'And how you tested it.';
    const h = scripted({ [A]: [800, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(100);
    void h.s.onRemoteFinal(C, 't2');
    await run(1000);
    expect(new Set(h.answered.map((a) => a.questionId)).size).toBe(1);
    expect(texts(h).at(-1)).toBe(`${A} ${C}`);
  });

  it('a correction while the first is still classifying re-answers the same card with the corrected wording', async () => {
    const A = 'Tell me about the first project.';
    const C = 'Sorry, I meant the second project.';
    const h = scripted({ [A]: [800, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(100);
    void h.s.onRemoteFinal(C, 't2');
    await run(1000);
    expect(new Set(h.answered.map((a) => a.questionId)).size).toBe(1);
    expect(texts(h).at(-1)).toBe(`${A} ${C}`);
    expect(h.decisions).toContain('superseded');
  });

  it('call logistics right after a question never revise it', async () => {
    const A = 'Why are you interested in this role?';
    const L = 'Sorry, can you hear me okay? I think my audio cut out.';
    const h = scripted({});
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    void h.s.onRemoteFinal(L, 't2');
    await run(10);
    expect(texts(h)).toEqual([A]); // not re-answered as "…can you hear me"
    expect(h.decisions).not.toContain('superseded');
  });

  it('a new complete question starting with "And" is its own card, not a revision', async () => {
    const A = 'Walk me through the ledger migration.';
    const B = 'And why are you interested in this role at Google?';
    const h = scripted({});
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    void h.s.onRemoteFinal(B, 't2');
    await run(10);
    await h.finish();
    expect(texts(h)).toEqual([A, B]);
    expect(new Set(h.answered.map((a) => a.questionId)).size).toBe(2);
  });

  // ---- late verdicts ----
  it('late "yes" after a NEWER question was asked: the newer one is answered, the late one is a missed card', async () => {
    const A = 'The thing with the queues last year.';
    const B = 'Why did you leave Acme?';
    const l = late();
    const h = scripted({ [A]: [10, l.d] });
    void h.s.onRemoteFinal(A, 't1');
    await run(50);
    void h.s.onRemoteFinal(B, 't2');
    await run(10);
    l.resolve(verdict(true));
    await run(10);
    expect(texts(h)).toEqual([B]);
    expect(h.missed).toEqual([{ text: A, why: 'late' }]);
  });

  it('late "yes" while nothing moved on: answered', async () => {
    const A = 'The thing with the queues last year.';
    const l = late();
    const h = scripted({ [A]: [10, l.d] });
    void h.s.onRemoteFinal(A, 't1');
    await run(50);
    l.resolve(verdict(true));
    await run(10);
    expect(texts(h)).toEqual([A]);
  });

  // ---- arriving during generation / manual Ask ----
  it('questions arriving while a MANUAL ASK holds the slot are queued in arrival order, then answered', async () => {
    const A = 'The thing with the queues last year.';
    const B = 'Why did you leave Acme?';
    const h = scripted({ [A]: [500, verdict(true)] });
    let busy = true; // a manual Ask is streaming
    h.deps.slotBusy = () => busy;
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    void h.s.onRemoteFinal(B, 't2');
    await run(600);
    expect(h.answered).toHaveLength(0);
    expect(h.s.pending.map((j) => j.text)).toEqual([A, B]);
    busy = false;
    h.s.slotFreed();
    await run(0);
    expect(texts(h)).toEqual([A]);
    await h.finish();
    expect(texts(h)).toEqual([A, B]);
  });

  it('a question arriving while an answer GENERATES is detected immediately and answered next', async () => {
    const A = 'Tell me about yourself.';
    const B = 'The thing with the queues last year.';
    const h = scripted({ [B]: [300, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    h.s.onCandidateTurn();
    vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1);
    void h.s.onRemoteFinal(B, 't2');
    await run(10);
    expect(h.calls).toContain(B); // detection did not wait for the stream
    await run(400);
    expect(h.s.pending.map((j) => j.text)).toEqual([B]);
    await h.finish();
    expect(texts(h)).toEqual([A, B]);
  });

  // ---- overflow, pause, stop, stale ----
  it('queue overflow: the oldest waiting question becomes a missed card; none is lost', async () => {
    const h = scripted({});
    void h.s.onRemoteFinal('Tell me about yourself.', 't0');
    await run(10);
    const qs = ['Why Acme?', 'Why this role?', 'What is your notice period?', 'What salary do you expect?'];
    for (const [i, q] of qs.entries()) {
      h.s.onCandidateTurn();
      vi.advanceTimersByTime(CONTINUATION_WINDOW_MS + 1);
      void h.s.onRemoteFinal(q, `t${i + 1}`);
      await run(10);
    }
    expect(QUEUE_MAX).toBe(3);
    expect(h.missed).toEqual([{ text: qs[0], why: 'queue-full' }]);
    expect(h.s.pending.map((j) => j.text)).toEqual(qs.slice(1));
  });

  it('pause while a question is still classifying: a visible missed card, not a silent drop', async () => {
    const A = 'The thing with the queues last year.';
    const h = scripted({ [A]: [500, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(100);
    h.s.pause();
    await run(500);
    expect(h.answered).toHaveLength(0);
    expect(h.missed).toEqual([{ text: A, why: 'paused' }]);
  });

  it('pause, resume, and a stale "yes" from before the pause: missed card, never a late answer', async () => {
    const A = 'The thing with the queues last year.';
    const h = scripted({ [A]: [500, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(100);
    h.s.pause();
    h.s.resume();
    await run(500);
    expect(h.answered).toHaveLength(0);
    expect(h.missed).toEqual([{ text: A, why: 'paused' }]);
  });

  it('a late verdict arriving after pause: missed card; after STOP: nothing (the session is over)', async () => {
    const A = 'The thing with the queues last year.';
    for (const action of ['pause', 'stop'] as const) {
      const l = late();
      const h = scripted({ [A]: [10, l.d] });
      void h.s.onRemoteFinal(A, 't1');
      await run(50);
      h.s[action]();
      l.resolve(verdict(true));
      await run(10);
      expect(h.answered).toHaveLength(0);
      expect(h.missed).toEqual(action === 'pause' ? [{ text: A, why: 'paused' }] : []);
    }
  });

  it('stop while classifications are in flight: nothing answered, nothing surfaced, no stray timers', async () => {
    const A = 'The thing with the queues last year.';
    const B = 'Why did you leave Acme?';
    const h = scripted({ [A]: [500, verdict(true)] });
    void h.s.onRemoteFinal(A, 't1');
    await run(10);
    void h.s.onRemoteFinal(B, 't2');
    h.s.stop();
    await run(1000);
    expect(h.answered).toHaveLength(0);
    expect(h.missed).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
