import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';
import { FIXTURE, SETTINGS } from './harness/aiFixture';

// The real Cue Card (renderer harness: hidden window, fake bridge, no app
// main, provider, audio or capture) under the AI-01 configuration: Anthropic
// answers the interview, the coding solver is overridden to OpenAI. Each
// control must name its task and the model main resolved for the NEXT
// request; an existing answer keeps the model that produced it.
/* eslint-disable @typescript-eslint/no-explicit-any */

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());

const test = base.extend<{ cue: Page }>({
  cue: async ({}, use) => {
    const page = await harness.load('overlay');
    await page.setViewportSize({ width: 467, height: 462 });
    await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
    await page.evaluate(() => (window as any).__fake.emit('onSessionState', { status: 'live', paused: false }));
    await use(page);
  },
});

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__fake.emit(e, p), [event, payload] as const);

const interview = (page: Page, interviewType: 'general' | 'technical' | 'coding') =>
  emit(page, 'onAnswerPrefs', { interviewType, format: 'general', pronunciation: false });

/** A finished answer card, as main streams it — with the route it was sent on. */
async function answer(page: Page, id: string, title: string, answeredBy: unknown, sentTo?: unknown) {
  await emit(page, 'onContributionOpen', { contributionId: id, kind: 'answer', title });
  if (sentTo) await emit(page, 'onContributionPatch', { contributionId: id, context: { questionId: id, question: title, chunks: [], sentTo } });
  await emit(page, 'onContributionDelta', { contributionId: id, token: 'A grounded answer.' });
  await emit(page, 'onContributionPatch', { contributionId: id, meta: { questionId: id, riskWarning: null, answeredBy } });
  await emit(page, 'onContributionDone', { contributionId: id });
}

const openMore = async (page: Page) => {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  return page.getByLabel('More controls');
};

const setArgs = (page: Page) =>
  page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'settings.set').map((a: any) => a.args[0]));
const calls = (page: Page) => page.evaluate(() => (window as any).__fake.calls as string[]);
const reply = (page: Page, path: string, value: unknown) =>
  page.evaluate(([p, v]) => ((window as any).__fake.replies[p] = v), [path, value] as const);

test('a General interview names Interview answers and the model main resolved — not the coding override or the OpenAI table', async ({ cue: page }) => {
  await interview(page, 'general');
  const tray = await openMore(page);
  await expect(tray.getByRole('combobox')).toHaveCount(1); // no coding control here
  const chip = tray.getByRole('combobox', { name: 'Interview answers model' });
  await expect(chip).toHaveText(/Claude Sonnet 5\.5/);
  await expect(tray).toContainText('Interview answers');
  await expect(tray).not.toContainText('GPT-6 Luna'); // the preset table the chip used to read
  await expect(tray).not.toContainText('GPT-6.2 Astra'); // the coding-only override
  await chip.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Interview answers: the next answer uses Anthropic · Claude Sonnet 5.5 (automatic).');
});

test('a coding interview names both tasks; a solver pick applies to the next solve, an answer pick re-answers', async ({ cue: page }) => {
  await interview(page, 'coding');
  await answer(page, 'q1', 'Explain your approach.', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const tray = await openMore(page);
  const answers = tray.getByRole('combobox', { name: 'Interview answers model' });
  const solver = tray.getByRole('combobox', { name: 'Coding solver model' });
  await expect(answers).toHaveText(/Claude Sonnet 5\.5/);
  await expect(solver).toHaveText(/GPT-6\.2 Astra/);
  await page.evaluate(() => ((window as any).__fake.calls = []));

  // Solver → Automatic: clears ONLY the coding override (main merges the one
  // key); nothing is re-answered.
  await reply(page, 'settings.set', { ...SETTINGS, models: {}, effectiveModels: { ...SETTINGS.effectiveModels, coding: 'anthropic/claude-opus-5-5' } });
  await solver.click();
  await page.getByRole('option', { name: /^Automatic — Claude Opus 5\.5/ }).click();
  await expect(solver).toHaveText(/Claude Opus 5\.5/);
  expect((await setArgs(page)).at(-1)).toEqual({ modelOverrides: { coding: null } });
  expect(await calls(page)).not.toContain('session.regenerate');

  // Answers → Claude Haiku 5.5: stored for the answer task, and the current question re-answered.
  await reply(page, 'settings.set', { ...SETTINGS, models: { answer: 'anthropic/claude-haiku-5-5' }, effectiveModels: { ...SETTINGS.effectiveModels, answer: 'anthropic/claude-haiku-5-5' } });
  await answers.click();
  // The first row of a group also carries the group's heading in its name.
  await page.getByRole('option', { name: /^(Anthropic )?Claude Haiku 5\.5 / }).click();
  await expect(answers).toHaveText(/Claude Haiku 5\.5/);
  expect((await setArgs(page)).at(-1)).toEqual({ modelOverrides: { answer: 'anthropic/claude-haiku-5-5' } });
  await expect.poll(() => calls(page)).toContain('session.regenerate');
});

test('a route change pushed by main relabels the chip; existing answers keep the model and provider that produced them', async ({ cue: page }) => {
  await interview(page, 'general');
  await answer(page, 'q1', 'Tell me about a project.', { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const card = page.locator('.cue-current');
  await expect(card.locator('[data-answered-by]')).toHaveText('Answered by Claude Sonnet 5.5');
  await expect(card).toContainText('Sources sent to Anthropic (0)'); // its own route, not readiness (OpenAI)

  // A same-provider failover: main marks Sonnet unavailable and pushes settings.
  const tray = await openMore(page);
  const notice = "Claude Sonnet 5.5 isn't available to your account — using Claude Haiku 5.5.";
  await emit(page, 'onSettingsChanged', {
    ...SETTINGS,
    effectiveModels: { ...SETTINGS.effectiveModels, answer: 'anthropic/claude-haiku-5-5' },
    autoModels: { ...SETTINGS.autoModels, answer: 'anthropic/claude-haiku-5-5' },
    modelNotices: { answer: notice },
  });
  const chip = tray.getByRole('combobox', { name: 'Interview answers model' });
  await expect(chip).toHaveText(/⚠ Claude Haiku 5\.5/);
  await chip.hover();
  await expect(page.getByRole('tooltip')).toContainText(notice);
  await expect(card.locator('[data-answered-by]')).toHaveText('Answered by Claude Sonnet 5.5'); // not relabelled

  // The failover answer names the model that answered, and what was tried first.
  await answer(page, 'q2', 'And the outcome?', {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    failed: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', reason: 'model' }],
  });
  const latest = page.locator('.cue-current [data-answered-by]');
  await expect(latest).toHaveText('Answered by Claude Haiku 5.5');
  await expect(latest).toHaveAttribute('title', 'Anthropic · Claude Haiku 5.5. Tried first: Claude Sonnet 5.5 (not available).');

  // The user switches answers to OpenAI meanwhile: earlier answers keep theirs.
  await emit(page, 'onSettingsChanged', { ...SETTINGS, models: { answer: 'gpt-6-luna' }, effectiveModels: { ...SETTINGS.effectiveModels, answer: 'gpt-6-luna' } });
  await expect(chip).toHaveText(/GPT-6 Luna/);
  await expect(latest).toHaveText('Answered by Claude Haiku 5.5');
});

test('Cue Card settings uses the shared solver picker — Automatic names the real pick, no legacy list — and never opens a microphone', async ({ cue: page }) => {
  const tray = await openMore(page);
  await tray.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cue Card settings' });
  await expect(dialog).toContainText('not by interview answers');
  const model = dialog.getByRole('combobox', { name: 'Coding solver model' });
  await expect(model).toHaveText(/GPT-6\.2 Astra/);
  await model.click();
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option', { name: /^Automatic — Claude Opus 5\.5/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^(Anthropic )?Claude Sonnet 5\.5 / })).toBeVisible(); // the shared catalog, every provider
  await expect(list).not.toContainText('o4-mini'); // the legacy hard-coded list is gone
  await expect(list).not.toContainText('Default (');

  await reply(page, 'settings.set', { ...SETTINGS, models: {}, effectiveModels: { ...SETTINGS.effectiveModels, coding: 'anthropic/claude-opus-5-5' } });
  await list.getByRole('option', { name: /^Automatic — Claude Opus 5\.5/ }).click();
  await expect(model).toHaveText(/Automatic — Claude Opus 5\.5/);
  expect((await setArgs(page)).at(-1)).toEqual({ modelOverrides: { coding: null } }); // the effort is not rewritten

  // A notice pushed while open is shown with the model the next solve uses.
  await emit(page, 'onSettingsChanged', {
    ...SETTINGS,
    models: { coding: 'anthropic/claude-fable-5-2' },
    effectiveModels: { ...SETTINGS.effectiveModels, coding: 'anthropic/claude-opus-5-5' },
    modelNotices: { coding: "Your coding override Claude Fable 5.2 can't be used (your account does not list it) — using the Anthropic balanced pick instead." },
  });
  await expect(dialog.locator('[data-model-notice="coding"]')).toContainText('Next solve: Claude Opus 5.5.');

  // The device-list probe ran — and was refused before any device opened.
  expect(await page.evaluate(() => (window as any).__fake.media)).toEqual(['getUserMedia']);
});
