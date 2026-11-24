import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';
import { LatencyRecorder } from '../src/main/services/engine/metrics/latency';

/**
 * M7.2b / PERF-01 — the latency record's acceptance measure is the first
 * USEFUL answer paint. The real Cue Card reports it to main only once the
 * painted text holds a real word: an answer opening with a bare "**" (the
 * bold lead) or "- " (a bullet) has painted nothing readable yet. Renderer
 * harness: hidden window, fake bridge, no provider, no audio.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex' }],
  readiness: {
    chat: { ready: true, provider: 'openai', model: 'm', classifyModel: 'm', explanation: 'x' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    routes: { answer: 'openai', classify: 'openai', parsing: 'openai' },
    features: {},
  },
};

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());
const test = base.extend<{ cue: Page }>({
  cue: async ({}, use) => {
    const page = await harness.load('overlay');
    await page.waitForFunction(() => (window as any).__fake.listening('onContributionDelta') > 0);
    await page.evaluate(() => (window as any).__fake.emit('onSessionState', { status: 'live', paused: false }));
    await use(page);
  },
});

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__fake.emit(e, p), [event, payload] as const);
/** The paint reports sent to main: [contributionId, at]. */
const reports = (page: Page) =>
  page.evaluate(() =>
    (window as any).__fake.args
      .filter((a: any) => a.path === 'metrics.firstUseful' || a.path === 'metrics.firstVisible')
      .map((a: any) => [a.path, a.args[0]]),
  );
/** Let the stream buffer flush and two animation frames pass. */
const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));

test('Markdown alone is not a useful paint; the first real word is — reported once, after it is on screen', async ({ cue: page }) => {
  await emit(page, 'onContributionOpen', { contributionId: 'q1', kind: 'answer', title: 'Tell me about a migration you led.' });
  await emit(page, 'onContributionDelta', { contributionId: 'q1', token: '**' });
  await frames(page);
  await emit(page, 'onContributionDelta', { contributionId: 'q1', token: ' ' });
  await frames(page);
  expect(await reports(page)).toEqual([]); // nothing readable yet

  const before = Date.now();
  await emit(page, 'onContributionDelta', { contributionId: 'q1', token: 'I led' });
  await expect(page.getByText('I led')).toBeVisible();
  await expect.poll(() => reports(page)).toHaveLength(1);
  const [[path, id]] = await reports(page);
  expect([path, id]).toEqual(['metrics.firstUseful', 'q1']);
  const at = (await page.evaluate(() => (window as any).__fake.args.find((a: any) => a.path === 'metrics.firstUseful').args[1])) as number;
  expect(at).toBeGreaterThanOrEqual(before);

  await emit(page, 'onContributionDelta', { contributionId: 'q1', token: ' the billing cut-over.**' });
  await frames(page);
  expect(await reports(page)).toHaveLength(1); // once per card
});

test('a bullet marker split across tokens waits for its word; a regenerated card reports again', async ({ cue: page }) => {
  await emit(page, 'onContributionOpen', { contributionId: 'q2', kind: 'answer', title: 'What was the hardest bug?' });
  for (const token of ['-', ' ', '[1]']) {
    await emit(page, 'onContributionDelta', { contributionId: 'q2', token });
    await frames(page);
  }
  expect(await reports(page)).toEqual([]);
  await emit(page, 'onContributionDelta', { contributionId: 'q2', token: ' A race' });
  await expect.poll(() => reports(page)).toEqual([['metrics.firstUseful', 'q2']]);

  // Regenerate: the card is cleared and streams again — a new paint.
  await emit(page, 'onContributionReset', { contributionId: 'q2' });
  await emit(page, 'onContributionDelta', { contributionId: 'q2', token: '**' });
  await frames(page);
  expect(await reports(page)).toHaveLength(1);
  await emit(page, 'onContributionDelta', { contributionId: 'q2', token: 'A deadlock' });
  await expect.poll(() => reports(page)).toHaveLength(2);
});

/** Hand the page's animation frames to the test: `advance()` runs every
 *  frame callback queued so far, once. */
async function holdFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__frames = new Map();
    w.__frameId = 100000;
    window.requestAnimationFrame = (fn) => {
      const id = ++w.__frameId;
      w.__frames.set(id, fn);
      return id;
    };
    window.cancelAnimationFrame = (id) => w.__frames.delete(id);
    w.__advance = () => {
      const callbacks = [...w.__frames.values()];
      w.__frames.clear();
      callbacks.forEach((fn: FrameRequestCallback) => fn(performance.now()));
    };
  });
}
/** Deliver the page's paint reports to a REAL recorder, as metrics.ipc does. */
async function deliver(page: Page, recorder: LatencyRecorder) {
  const paints = await page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'metrics.firstUseful').map((a: any) => a.args));
  for (const [id, at, take] of paints) recorder.mark(id, { firstUsefulAt: at }, take);
  return paints as [string, number, number | undefined][];
}

// M7.2b review, finding 3 (Codex's reproduction): the old card's two-frame
// acknowledgement is still pending when the card is reset and its
// replacement starts with only "**"; the old frames run after the new
// take's first token. The replacement must stay unpainted.
test('a pending paint report from before a reset never satisfies the replacement take', async ({ cue: page }) => {
  const recorder = new LatencyRecorder();
  const old = recorder.begin({ questionId: 'race', sessionId: 's', finalAt: Date.now() });
  recorder.mark('race', { firstTokenAt: Date.now() }, old);
  await holdFrames(page);
  await page.evaluate((take) => {
    const w = window as any;
    w.__fake.emit('onContributionOpen', { contributionId: 'race', kind: 'answer', title: 'Old question' });
    w.__fake.emit('onContributionPatch', { contributionId: 'race', latencyTake: take });
    w.__fake.emit('onContributionDelta', { contributionId: 'race', token: 'Old answer' });
    w.__advance(); // flush the old words; their acknowledgement is pending
  }, old);
  await expect(page.locator('.cue-current')).toContainText('Old answer');

  const next = recorder.begin({ questionId: 'race', sessionId: 's', finalAt: Date.now() });
  recorder.mark('race', { firstTokenAt: Date.now() }, next);
  await page.evaluate((take) => {
    const w = window as any;
    w.__fake.emit('onContributionReset', { contributionId: 'race' });
    w.__fake.emit('onContributionPatch', { contributionId: 'race', latencyTake: take });
    w.__fake.emit('onContributionDelta', { contributionId: 'race', token: '**' });
    w.__fake.emit('onContributionDone', { contributionId: 'race' }); // flush syntax only
    w.__advance();
    w.__advance(); // the OLD callback's frames run now, after the new first token
  }, next);
  await expect(page.locator('.cue-current')).not.toContainText('Old answer');
  expect(await deliver(page, recorder)).toEqual([]); // the old callback reported nothing
  expect(recorder.get('race')?.firstUsefulAt).toBeUndefined();
});

test("control: the replacement take's own words are reported with its take and accepted", async ({ cue: page }) => {
  const recorder = new LatencyRecorder();
  const old = recorder.begin({ questionId: 'again', sessionId: 's', finalAt: Date.now() });
  recorder.mark('again', { firstTokenAt: Date.now() }, old);
  await holdFrames(page);
  await page.evaluate((take) => {
    const w = window as any;
    w.__fake.emit('onContributionOpen', { contributionId: 'again', kind: 'answer', title: 'Old question' });
    w.__fake.emit('onContributionPatch', { contributionId: 'again', latencyTake: take });
    w.__fake.emit('onContributionDelta', { contributionId: 'again', token: 'Old answer' });
    w.__advance();
  }, old);
  const next = recorder.begin({ questionId: 'again', sessionId: 's', finalAt: Date.now() });
  recorder.mark('again', { firstTokenAt: Date.now() }, next);
  await page.evaluate((take) => {
    const w = window as any;
    w.__fake.emit('onContributionReset', { contributionId: 'again' });
    w.__fake.emit('onContributionPatch', { contributionId: 'again', latencyTake: take });
    w.__fake.emit('onContributionDelta', { contributionId: 'again', token: '**New' });
    w.__advance(); // flush the new words
    w.__advance(); // first frame (and the void old one)
    w.__advance(); // second frame: after paint
  }, next);
  await expect(page.locator('.cue-current')).toContainText('New');
  const paints = await deliver(page, recorder);
  expect(paints.map(([id, , take]) => [id, take])).toEqual([['again', next]]);
  expect(recorder.get('again')?.firstUsefulAt).toBe(paints[0][1]);
});
