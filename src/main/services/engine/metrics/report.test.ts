import { describe, expect, it } from 'vitest';
import { buildReport, parseJsonl, renderMarkdown, type Row } from './report';

let n = 0;
const row = (over: Partial<Row> = {}): Row => {
  const id = `q${++n}`;
  return {
    questionId: id,
    sessionId: 's',
    take: n,
    category: 'general',
    cold: false,
    finalAt: 0,
    decidedAt: 5,
    dispatchAt: 10,
    requestAt: 10,
    firstTokenAt: 900,
    firstUsefulAt: 1000,
    completedAt: 2000,
    outcome: 'answered',
    provider: 'openai',
    model: 'gpt-6-luna',
    effort: 'none',
    chunks: 5,
    memories: 1,
    ...over,
  };
};
const many = (k: number, over: Partial<Row> = {}) => Array.from({ length: k }, () => row(over));

describe('PERF-01 report', () => {
  it('a simulated report never says "met", however fast', () => {
    const r = buildReport([...many(30), ...many(30, { category: 'technical' }), ...many(5, { cold: true })], { simulated: true, title: 'x' });
    expect(r.verdicts.general).toEqual({
      samples: 'simulated — not acceptance',
      usefulP50: 'simulated — not acceptance',
      usefulP95: 'simulated — not acceptance',
      cold: 'simulated — not acceptance',
    });
    expect(renderMarkdown(r).split('\n')[2]).toMatch(/^\*\*SIMULATED/);
    expect(renderMarkdown(r)).not.toMatch(/\| met \|/);
  });

  it('a live run is judged per category; too few samples is never "met"', () => {
    const slow = many(2, { category: 'technical', firstUsefulAt: 4000 });
    const r = buildReport(
      [...many(30), ...many(5, { cold: true }), ...many(28, { category: 'technical' }), ...slow],
      { simulated: false, title: 'live' },
    );
    expect(r.verdicts.general).toEqual({ samples: 'met', usefulP50: 'met', usefulP95: 'met', cold: 'met' });
    expect(r.verdicts.technical).toMatchObject({ samples: 'met', usefulP50: 'met', usefulP95: 'not met', cold: 'insufficient samples' });
    const few = buildReport(many(10), { simulated: false, title: 'few' });
    expect(few.verdicts.general.usefulP95).toBe('insufficient samples');
  });

  it('unanswered questions stay in the denominator and are listed by fixture id', () => {
    const r = buildReport(
      [...many(28), row({ fixtureId: 'G29', outcome: 'failed', reason: 'network', firstTokenAt: undefined, firstUsefulAt: undefined }), row({ fixtureId: 'G30', firstUsefulAt: undefined })],
      { simulated: false, title: 'x' },
    );
    expect(r.summary.byCategory.general.warm.endToEnd).toMatchObject({ n: 30, unanswered: 2 });
    expect(r.verdicts.general.usefulP95).toBe('not met'); // 2 of 30 unanswered → p95 is "not answered"
    expect(r.unanswered).toEqual([
      { id: 'G29', category: 'general', outcome: 'failed', reason: 'network' },
      { id: 'G30', category: 'general', outcome: 'answered, never painted' },
    ]);
  });

  it('one sample per question — its latest take; superseded takes are counted, not sampled', () => {
    const first = row({ questionId: 'same', take: 1, outcome: 'superseded', firstUsefulAt: undefined });
    const second = row({ questionId: 'same', take: 2, finalAt: 3000, firstTokenAt: 3500, firstUsefulAt: 3600 });
    const r = buildReport([first, second], { simulated: false, title: 'x' });
    expect(r.superseded).toBe(1);
    expect(r.summary.byCategory.general.warm.endToEnd).toMatchObject({ n: 1, p50: 600 });
  });

  it('decision p95 uses every evaluated turn when the in-app summary supplies it', () => {
    const rows = many(30, { decidedAt: 100 });
    expect(buildReport(rows, { simulated: false, title: 'x' }).decision).toBe('met');
    expect(buildReport(rows, { simulated: false, title: 'x', decisionsAllTurns: { n: 200, p50: 0, p95: 1800 } }).decision).toBe('not met');
  });

  it('routes and context sizes are reported', () => {
    const r = buildReport([...many(3), row({ provider: undefined, model: undefined, effort: undefined, outcome: 'missed' })], { simulated: true, title: 'x' });
    expect(r.routes).toEqual({ 'openai/gpt-6-luna · effort none': 3, 'no route (never dispatched)': 1 });
    expect(r.context.chunks).toMatchObject({ n: 4, p50: 5 });
  });

  it('parses latency.jsonl, skipping blank and broken lines', () => {
    const text = `${JSON.stringify(row())}\n\nnot json\n${JSON.stringify({ hello: 1 })}\r\n${JSON.stringify(row())}\n`;
    const { rows, skipped } = parseJsonl(text);
    expect(rows).toHaveLength(2);
    expect(skipped).toBe(2);
  });
});
