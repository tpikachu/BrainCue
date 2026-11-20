import { describe, expect, it } from 'vitest';
import type { Row } from '../metrics/report';
import { attribute, attributeAll, collectAnswer, pickSample, settle, type CollectDeps, type DetectedQuestion, type FixtureText, type FixtureWindow } from './perf01.collect';
import { GENERAL, TECHNICAL } from './perf01.fixtures';
import { LatencyRecorder } from '../metrics/latency';

/**
 * The live driver's record attribution, OFFLINE. These run the same
 * functions e2e/live-perf01.spec.ts collects with. Its Page and file
 * reads are replaced by fakes that write records in the order a live run
 * can produce them.
 */
const A: FixtureText = { id: 'G01', text: GENERAL[0].text };
const B: FixtureText = { id: 'G02', text: GENERAL[1].text };
const C: FixtureText = { id: 'G03', text: GENERAL[2].text };
const FIX = [A, B, C];

const rec = (over: Partial<Row> & { questionId: string }): Row => ({
  sessionId: 's',
  take: 1,
  category: 'general',
  cold: false,
  finalAt: 0,
  outcome: 'answered',
  firstUsefulAt: 1000,
  ...over,
});

/** A fake live run: a clock, a latency file and the detected questions, with
 *  events scheduled at clock times (as the app would write them). */
function fakeRun(events: { at: number; row?: Row; question?: DetectedQuestion }[]) {
  let t = 0;
  const rows: Row[] = [];
  const questions = new Map<string, DetectedQuestion>();
  const pending = [...events].sort((a, b) => a.at - b.at);
  const advance = () => {
    while (pending.length && pending[0].at <= t) {
      const e = pending.shift()!;
      if (e.row) rows.push(e.row);
      if (e.question) questions.set(e.question.id, e.question);
    }
  };
  const deps: CollectDeps = {
    readRows: () => (advance(), [...rows]),
    readQuestions: async () => (advance(), new Map(questions)),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { deps, setNow: (v: number) => ((t = v), advance()), rows };
}

describe('PERF-01 record attribution', () => {
  it('every fixture question (and the warm-up) attributes to itself, clearly', () => {
    for (const set of [GENERAL, TECHNICAL]) {
      const fixtures = [{ id: 'W00', text: 'Could you start by telling me a little about yourself?' }, ...set.map((q) => ({ id: q.id, text: q.text }))];
      for (const f of fixtures) {
        // as speech-to-text would return it: different case, punctuation lost
        const heard = f.text.toLowerCase().replace(/[?.,!]/g, '');
        const a = attribute(rec({ questionId: 'q' }), new Map([['q', { id: 'q', text: heard }]]), fixtures, []);
        expect(a, f.id).toMatchObject({ fixtureId: f.id, how: 'text' });
      }
    }
  });

  it('the review case: A times out, its late record arrives while B is asked — it stays A, and B waits for its own', async () => {
    const win: FixtureWindow[] = [
      { id: 'G01', audioStartAt: 0 },
      { id: 'G02', audioStartAt: 40_000 },
    ];
    const run = fakeRun([
      { at: 2_000, question: { id: 'qa', text: A.text } },
      // A's answer finishes long after its timeout, while B's audio is playing
      { at: 41_000, row: rec({ questionId: 'qa', finalAt: 2_000, firstUsefulAt: 39_000 }) },
      { at: 43_000, question: { id: 'qb', text: B.text } },
      { at: 46_000, row: rec({ questionId: 'qb', finalAt: 43_000, firstUsefulAt: 44_200 }) },
    ]);
    run.setNow(40_000);
    const got = await collectAnswer(run.deps, B, FIX, win, 30_000);
    expect(got.timedOut).toBe(false);
    expect(got.sample?.questionId).toBe('qb'); // NOT qa, which was written first
    expect(got.attribution).toMatchObject({ fixtureId: 'G02', how: 'text', late: false });
    const all = attributeAll(run.rows, new Map([['qa', { id: 'qa', text: A.text }], ['qb', { id: 'qb', text: B.text }]]), FIX, win);
    expect(all.map((x) => x.fixtureId)).toEqual(['G01', 'G02']);
  });

  it('a final that lands in the next window still belongs to its own text (late final)', () => {
    const win = [
      { id: 'G01', audioStartAt: 0 },
      { id: 'G02', audioStartAt: 10_000 },
    ];
    const a = attribute(rec({ questionId: 'qa', finalAt: 10_500 }), new Map([['qa', { id: 'qa', text: A.text }]]), FIX, win);
    expect(a).toMatchObject({ fixtureId: 'G01', how: 'text', late: true });
  });

  it('out-of-order completions: C finishes before B; each gets its own', async () => {
    const win = [
      { id: 'G02', audioStartAt: 0 },
      { id: 'G03', audioStartAt: 20_000 },
    ];
    const run = fakeRun([
      { at: 1_000, question: { id: 'qb', text: B.text } },
      { at: 21_000, question: { id: 'qc', text: C.text } },
      { at: 22_500, row: rec({ questionId: 'qc', finalAt: 21_000 }) },
      { at: 23_000, row: rec({ questionId: 'qb', finalAt: 1_000 }) },
    ]);
    run.setNow(20_000);
    expect((await collectAnswer(run.deps, C, FIX, win, 30_000)).sample?.questionId).toBe('qc');
    expect((await collectAnswer(run.deps, B, FIX, win, 30_000)).sample?.questionId).toBe('qb');
  });

  it('a split final (two cards for one fixture): the first detected is the sample, the other is counted, not sampled', () => {
    const half1 = A.text.split(' ').slice(0, 6).join(' ');
    const half2 = A.text;
    const rows = [rec({ questionId: 'q2', finalAt: 3_000 }), rec({ questionId: 'q1', finalAt: 2_000 })];
    const qs = new Map([
      ['q1', { id: 'q1', text: half1 }],
      ['q2', { id: 'q2', text: half2 }],
    ]);
    const att = attributeAll(rows, qs, FIX, [{ id: 'G01', audioStartAt: 0 }]);
    const pick = pickSample(rows, att, 'G01');
    expect(pick.sample?.questionId).toBe('q1');
    expect(pick.extraQuestions).toEqual(['q2']);
  });

  it('several takes of one question: the latest take is the sample; superseded takes are counted', () => {
    const rows = [
      rec({ questionId: 'qa', take: 3, outcome: 'superseded', firstUsefulAt: undefined }),
      rec({ questionId: 'qa', take: 5, finalAt: 4_000, firstUsefulAt: 5_100 }),
    ];
    const att = attributeAll(rows, new Map([['qa', { id: 'qa', text: A.text }]]), FIX, []);
    const pick = pickSample(rows, att, 'G01');
    expect(pick.sample?.take).toBe(5);
    expect(pick.superseded).toBe(1);
  });

  it('a record with no text (missed before its card opened) goes to the window its final fell in', () => {
    const win = [
      { id: 'G01', audioStartAt: 0 },
      { id: 'G02', audioStartAt: 10_000 },
    ];
    const missed = rec({ questionId: 'job:s:7', finalAt: 11_000, outcome: 'missed', reason: 'queue-full', firstUsefulAt: undefined });
    expect(attribute(missed, new Map(), FIX, win)).toMatchObject({ fixtureId: 'G02', how: 'window' });
    expect(attribute(rec({ questionId: 'early', finalAt: -5 }), new Map(), FIX, win)).toMatchObject({ fixtureId: null, how: 'none' });
  });

  it('a detected question that matches no fixture clearly is not text-attributed (flagged as weak)', () => {
    const a = attribute(rec({ questionId: 'q', finalAt: 100 }), new Map([['q', { id: 'q', text: 'what is the weather like in lisbon today' }]]), FIX, [{ id: 'G01', audioStartAt: 0 }]);
    expect(a).toMatchObject({ fixtureId: 'G01', how: 'window-weak-text' });
  });

  it('control: the normal one-question case is collected at once', async () => {
    const run = fakeRun([
      { at: 1_000, question: { id: 'qa', text: A.text } },
      { at: 3_000, row: rec({ questionId: 'qa', finalAt: 1_000 }) },
    ]);
    const got = await collectAnswer(run.deps, A, FIX, [{ id: 'G01', audioStartAt: 0 }], 30_000);
    expect(got).toMatchObject({ timedOut: false, extraQuestions: [], superseded: 0 });
    expect(got.sample?.questionId).toBe('qa');
  });

  it('no record within the timeout: timed out, nothing borrowed from another fixture', async () => {
    const run = fakeRun([{ at: 500, row: rec({ questionId: 'qb', finalAt: 500 }) }, { at: 500, question: { id: 'qb', text: B.text } }]);
    const got = await collectAnswer(run.deps, A, FIX, [{ id: 'G01', audioStartAt: 0 }], 5_000);
    expect(got).toMatchObject({ timedOut: true, sample: null });
  });

  it('settle waits for in-flight answers, and reports what is still open at its deadline', async () => {
    const run = fakeRun([
      { at: 0, question: { id: 'qa', text: A.text } },
      { at: 4_000, row: rec({ questionId: 'qa', take: 1, outcome: 'superseded' }) },
      { at: 6_000, row: rec({ questionId: 'qa', take: 2 }) },
      { at: 7_000, question: { id: 'qb', text: B.text } },
    ]);
    expect(await settle(run.deps, 10_000)).toEqual({ settled: true, open: [] }); // at 6 s
    run.setNow(7_000);
    expect(await settle(run.deps, 2_000)).toEqual({ settled: false, open: ['qb'] });
  });

  describe('takes: an old finished take never stands in for the running replacement (review of 492a6cc)', () => {
    /** The REAL recorder, its sink feeding the file the collector reads. Timers
     *  are immediate, so a finished answered take is written when it paints. */
    function recorded() {
      const rows: Row[] = [];
      let t = 0;
      const rec = new LatencyRecorder(500, (r) => rows.push({ ...r } as Row), { set: (fn) => (fn(), 0), clear: () => {} });
      const questions = new Map<string, DetectedQuestion>([['qa', { id: 'qa', text: A.text, at: 1_000 }]]);
      const take1 = rec.begin({ questionId: 'qa', sessionId: 's', finalAt: 1_000 });
      questions.get('qa')!.take = take1;
      rec.mark('qa', { firstTokenAt: 1_900 }, take1);
      rec.mark('qa', { firstUsefulAt: 2_000 }, take1);
      rec.finish('qa', 'answered', { completedAt: 2_500 }, take1);
      const deps: CollectDeps = {
        readRows: () => [...rows],
        readQuestions: async () => new Map(questions),
        now: () => t,
        sleep: async (ms) => {
          t += ms;
          for (const e of pending.splice(0).filter((x) => (x.at <= t ? (x.run(), false) : true))) pending.push(e);
        },
      };
      const pending: { at: number; run: () => void }[] = [];
      /** A correction: take 2 starts now (announced to the Cue Card), finishes at `doneAt` (or never). */
      const correct = (doneAt: number | null) => {
        const take2 = rec.begin({ questionId: 'qa', sessionId: 's', finalAt: 3_000 });
        questions.get('qa')!.take = take2;
        if (doneAt !== null)
          pending.push({
            at: doneAt,
            run: () => {
              rec.mark('qa', { firstTokenAt: doneAt - 100 }, take2);
              rec.mark('qa', { firstUsefulAt: doneAt }, take2);
              rec.finish('qa', 'answered', { completedAt: doneAt + 200 }, take2);
            },
          });
        return take2;
      };
      return { rows, deps, correct, setNow: (v: number) => (t = v) };
    }
    const win = [{ id: 'G01', audioStartAt: 0 }];

    it('take 1 answered, take 2 running: collection waits for take 2 and returns it', async () => {
      const r = recorded();
      r.setNow(3_000);
      const take2 = r.correct(4_000);
      expect(r.rows.map((x) => [x.take, x.outcome])).toEqual([[1, 'answered']]); // take 1 is all the file holds
      const got = await collectAnswer(r.deps, A, FIX, win, 30_000);
      expect(got.sample).toMatchObject({ take: take2, outcome: 'answered', firstUsefulAt: 4_000 });
    });

    it('take 2 running: settle does not return until it finishes', async () => {
      const r = recorded();
      r.setNow(3_000);
      r.correct(5_000);
      const s = await settle(r.deps, 30_000);
      expect(s.settled).toBe(true);
      expect(r.deps.now()).toBeGreaterThanOrEqual(5_000); // not at 0 ms: it waited for the replacement
    });

    it('take 2 never finishes: collection times out with it pending (take 1 is not the sample), settle reports it open', async () => {
      const r = recorded();
      r.setNow(3_000);
      const take2 = r.correct(null);
      const got = await collectAnswer(r.deps, A, FIX, win, 5_000);
      expect(got).toMatchObject({ timedOut: true, sample: null, pending: { questionId: 'qa', take: take2 } });
      expect(await settle(r.deps, 2_000)).toEqual({ settled: false, open: ['qa'] });
    });

    it('control: with only take 1, it is the sample at once', async () => {
      const r = recorded();
      const got = await collectAnswer(r.deps, A, FIX, win, 30_000);
      expect(got).toMatchObject({ timedOut: false, sample: { take: 1, firstUsefulAt: 2_000 } });
      expect(await settle(r.deps, 1)).toEqual({ settled: true, open: [] });
    });

    it('a detected question with no record yet is the fixture’s question: a later split-off part does not jump ahead', async () => {
      const questions = new Map<string, DetectedQuestion>([
        ['first', { id: 'first', text: A.text, at: 1_000, take: 1 }],
        ['second', { id: 'second', text: A.text, at: 2_000, take: 2 }],
      ]);
      const rows = [rec({ questionId: 'second', take: 2, finalAt: 2_000 })];
      const pick = pickSample(rows, attributeAll(rows, questions, FIX, win), 'G01', questions, FIX, win);
      expect(pick).toMatchObject({ questionId: 'first', sample: null, pending: { questionId: 'first', take: 1 }, extraQuestions: ['second'] });
    });
  });
});
