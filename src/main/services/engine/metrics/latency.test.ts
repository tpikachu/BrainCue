import { describe, expect, it } from 'vitest';
import { LatencyRecorder, PAINT_GRACE_MS, endToEnd, latencyCategory, percentile, type QuestionTiming } from './latency';

/** Manual timers: the paint-grace wait runs only when the test says so. */
function manualTimers() {
  const due: { fn: () => void; ms: number }[] = [];
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const t = { fn, ms };
        due.push(t);
        return t;
      },
      clear: (t: unknown) => {
        const i = due.indexOf(t as (typeof due)[number]);
        if (i >= 0) due.splice(i, 1);
      },
    },
    runAll: () => due.splice(0).forEach((t) => t.fn()),
    pending: () => due.length,
  };
}

/** One answered question: final at `at`, first token +ft, useful paint +up, complete +done. */
function answered(r: LatencyRecorder, id: string, at: number, ft: number, up: number, extra: Partial<QuestionTiming> = {}) {
  const take = r.begin({ questionId: id, sessionId: 's', finalAt: at, decidedAt: at + 10, ...extra });
  r.mark(id, { dispatchAt: at + 20, requestAt: at + 30, firstTokenAt: at + ft }, take);
  r.mark(id, { firstUsefulAt: at + up }, take);
  r.finish(id, 'answered', { completedAt: at + up + 500 }, take);
  return take;
}

describe('percentile', () => {
  it('nearest-rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
  });
});

describe('latencyCategory — General, simple Technical and coding are measured apart', () => {
  it('buckets by the answer style in use; coding questions apart', () => {
    expect(latencyCategory('behavioral', 'general')).toBe('general');
    expect(latencyCategory('resume_project', 'general')).toBe('general');
    expect(latencyCategory('behavioral', 'technical')).toBe('technical');
    expect(latencyCategory('technical_concept', 'general')).toBe('general'); // the style decides
    expect(latencyCategory('system_design', 'technical')).toBe('technical');
    expect(latencyCategory('coding', 'technical')).toBe('coding');
    expect(latencyCategory('coding', 'general')).toBe('coding');
  });
});

describe('LatencyRecorder', () => {
  it('separates the first answer of the process (cold) from the rest, per category', () => {
    const r = new LatencyRecorder();
    answered(r, 'a', 0, 2500, 3000, { category: 'general' });
    answered(r, 'b', 10_000, 900, 1200, { category: 'general' });
    answered(r, 'c', 20_000, 1100, 1400, { category: 'technical' });
    const s = r.summary();
    expect(s.byCategory.general.cold.stages.finalToFirstUseful).toEqual({ n: 1, p50: 3000, p95: 3000 });
    expect(s.byCategory.general.warm.stages.finalToFirstUseful).toEqual({ n: 1, p50: 1200, p95: 1200 });
    expect(s.byCategory.technical.warm.stages.finalToFirstUseful).toEqual({ n: 1, p50: 1400, p95: 1400 });
    expect(s.byCategory.coding.all.samples).toBe(0);
    expect(s.byCategory.all.all.samples).toBe(3);
    // Each stage on its own.
    expect(s.byCategory.general.warm.stages.decisionToDispatch.p50).toBe(10);
    expect(s.byCategory.general.warm.stages.dispatchToRequest.p50).toBe(10);
    expect(s.byCategory.general.warm.stages.requestToFirstToken.p50).toBe(870);
    expect(s.byCategory.general.warm.stages.finalToComplete.p50).toBe(1700);
  });

  it('writes every finished question to the sink once — failed, aborted and missed included', () => {
    const sunk: QuestionTiming[] = [];
    const t = manualTimers();
    const r = new LatencyRecorder(10, (x) => sunk.push(x), t.timers);
    const fa = r.begin({ questionId: 'f', sessionId: 's', finalAt: 0 });
    r.finish('f', 'failed', { reason: 'auth' }, fa);
    const ab = r.begin({ questionId: 'x', sessionId: 's', finalAt: 0 });
    r.finish('x', 'aborted', {}, ab);
    r.missed({ questionId: 'm', sessionId: 's', finalAt: 0, decidedAt: 5, reason: 'queue-full' });
    r.finish('f', 'answered'); // already finished — ignored
    expect(sunk.map((x) => [x.questionId, x.outcome, x.reason])).toEqual([
      ['f', 'failed', 'auth'],
      ['x', 'aborted', undefined],
      ['m', 'missed', 'queue-full'],
    ]);
    const s = r.summary().byCategory.all.all;
    expect(s.outcomes).toMatchObject({ failed: 1, aborted: 1, missed: 1, answered: 0 });
    expect(s.endToEnd).toMatchObject({ n: 3, unanswered: 3, p50: null, p95: null });
  });

  it('an answered record waits for the paint report, then is written with it (first value wins)', () => {
    const sunk: QuestionTiming[] = [];
    const t = manualTimers();
    const r = new LatencyRecorder(10, (x) => sunk.push(x), t.timers);
    const take = r.begin({ questionId: 'a', sessionId: 's', finalAt: 0 });
    r.mark('a', { firstTokenAt: 800 }, take);
    r.finish('a', 'answered', { completedAt: 900 }, take);
    expect(sunk).toEqual([]); // the overlay paints after the last token
    expect(r.summary().byCategory.all.all.samples).toBe(0); // not finished until written
    r.mark('a', { firstUsefulAt: 950 }, take);
    r.mark('a', { firstUsefulAt: 2000 }, take);
    expect(sunk.map((x) => x.firstUsefulAt)).toEqual([950]);
    expect(t.pending()).toBe(0);
  });

  it('without a paint report (Cue Card hidden) it is written after the grace period — as not painted', () => {
    const sunk: QuestionTiming[] = [];
    const t = manualTimers();
    const r = new LatencyRecorder(10, (x) => sunk.push(x), t.timers);
    const take = r.begin({ questionId: 'a', sessionId: 's', finalAt: 0 });
    r.mark('a', { firstTokenAt: 800 }, take);
    r.finish('a', 'answered', { completedAt: 900 }, take);
    expect(PAINT_GRACE_MS).toBeGreaterThan(0);
    t.runAll();
    expect(sunk).toHaveLength(1);
    expect(sunk[0].firstUsefulAt).toBeUndefined();
    expect(r.summary().byCategory.all.all.endToEnd).toMatchObject({ n: 1, unanswered: 1 });
  });

  it('a revision starts a new take: the unfinished earlier take is written as superseded, and its late marks never reach the new one', () => {
    const sunk: QuestionTiming[] = [];
    const t = manualTimers();
    const r = new LatencyRecorder(10, (x) => sunk.push(x), t.timers);
    const first = r.begin({ questionId: 'q', sessionId: 's', finalAt: 0 });
    r.mark('q', { dispatchAt: 10 }, first);
    const second = r.begin({ questionId: 'q', sessionId: 's', finalAt: 3000 });
    expect(sunk.map((x) => [x.take, x.outcome])).toEqual([[first, 'superseded']]);
    // The first take's stream ends late, after its abort.
    r.mark('q', { firstTokenAt: 3100 }, first);
    r.finish('q', 'aborted', {}, first);
    expect(r.get('q')?.take).toBe(second);
    expect(r.get('q')?.outcome).toBeUndefined();
    expect(r.get('q')?.firstTokenAt).toBeUndefined();
    r.mark('q', { firstTokenAt: 3900 }, second);
    r.mark('q', { firstUsefulAt: 4000 }, second);
    r.finish('q', 'answered', { completedAt: 4500 }, second);
    expect(sunk.map((x) => [x.take, x.outcome])).toEqual([
      [first, 'superseded'],
      [second, 'answered'],
    ]);
    // One sample per question: the latest take, timed from ITS final.
    expect(r.summary().byCategory.all.all.stages.finalToFirstUseful).toEqual({ n: 1, p50: 1000, p95: 1000 });
  });

  it('a paint report from before this take\'s first token belongs to an earlier take and is dropped', () => {
    const r = new LatencyRecorder(10, undefined, manualTimers().timers);
    const take = r.begin({ questionId: 'q', sessionId: 's', finalAt: 1000 });
    r.mark('q', { firstUsefulAt: 1100 }, take); // no first token yet
    r.mark('q', { firstTokenAt: 1500 }, take);
    r.mark('q', { firstUsefulAt: 1400 }, take); // earlier than the first token
    expect(r.get('q')?.firstUsefulAt).toBeUndefined();
    r.mark('q', { firstUsefulAt: 1600 }, take);
    expect(r.get('q')?.firstUsefulAt).toBe(1600);
  });

  it('a paint report must name the current take — an old take\'s or an unowned one is rejected even when it is later than the new first token (M7.2b review)', () => {
    const r = new LatencyRecorder(10, undefined, manualTimers().timers);
    const old = r.begin({ questionId: 'q', sessionId: 's', finalAt: 1000 });
    r.mark('q', { firstTokenAt: 1200 }, old);
    const next = r.begin({ questionId: 'q', sessionId: 's', finalAt: 5000 });
    r.mark('q', { firstTokenAt: 5500 }, next);
    r.mark('q', { firstUsefulAt: 6000 }, old); // the old card's late acknowledgement
    r.mark('q', { firstUsefulAt: 6000 }); // no take at all
    expect(r.get('q')?.firstUsefulAt).toBeUndefined();
    r.mark('q', { firstUsefulAt: 6100 }, next); // the replacement's own words
    expect(r.get('q')?.firstUsefulAt).toBe(6100);
  });

  it('counts detection latency for every evaluated turn, questions or not', () => {
    const r = new LatencyRecorder();
    r.decision(0, 5);
    r.decision(0, 700);
    r.decision(100, 50); // clock skew → ignored
    expect(r.summary().decisions).toEqual({ n: 2, p50: 5, p95: 700 });
  });

  it('is bounded', () => {
    const r = new LatencyRecorder(3);
    for (let i = 0; i < 10; i++) r.begin({ questionId: `q${i}`, sessionId: 's', finalAt: i });
    expect(r.all().map((t) => t.questionId)).toEqual(['q7', 'q8', 'q9']);
  });
});

describe('endToEnd — unanswered questions count as slower than any answer', () => {
  const row = (useful?: number): QuestionTiming => ({
    questionId: 'x',
    sessionId: 's',
    take: 1,
    category: 'general',
    cold: false,
    finalAt: 0,
    outcome: useful === undefined ? 'failed' : 'answered',
    ...(useful !== undefined ? { firstTokenAt: 0, firstUsefulAt: useful } : {}),
  });

  it('a failure can push p95 to "not answered" but never make it look faster', () => {
    const fast = Array.from({ length: 19 }, () => row(1000));
    expect(endToEnd([...fast, row(2000)])).toMatchObject({ n: 20, unanswered: 0, p50: 1000, p95: 1000 });
    expect(endToEnd([...fast, row()])).toMatchObject({ n: 20, unanswered: 1, p50: 1000, p95: 1000 });
    expect(endToEnd([...fast.slice(0, 17), row(), row(), row()])).toMatchObject({ n: 20, unanswered: 3, p95: null });
    expect(endToEnd([row(1200), row(2800), row(3500), row()]).withinTarget).toEqual({ le1500: 1, le3000: 2 });
  });
});
