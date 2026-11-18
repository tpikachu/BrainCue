import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';

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
