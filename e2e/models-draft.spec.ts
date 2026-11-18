import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';
import { FIXTURE, snapshot } from './harness/aiFixture';

// M7.2a review, AI-02: Settings → Language Models (the real panel and the
// real settings store, with the dashboard shell's push → store subscription;
// only the bridge is fake). An unsaved per-task choice must survive incoming
// settings snapshots — main sends a fresh map with every push — while tasks
// not edited here refresh. Save must write exactly the edited choices.
/* eslint-disable @typescript-eslint/no-explicit-any */

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());

const test = base.extend<{ models: Page }>({
  models: async ({}, use) => {
    const page = await harness.load('modelsPanel');
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForFunction(() => (window as any).__fake.listening('onSettingsChanged') > 0);
    await use(page);
  },
});

const HAIKU = 'anthropic/claude-haiku-5-5';
const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__fake.emit(e, p), [event, payload] as const);
const reply = (page: Page, path: string, value: unknown) =>
  page.evaluate(([p, v]) => ((window as any).__fake.replies[p] = v), [path, value] as const);
const setArgs = (page: Page) =>
  page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'settings.set').map((a: any) => a.args[0]));
const settle = async (page: Page, id: string, value: unknown) => {
  await expect.poll(() => page.evaluate(() => (window as any).__fake.deferredIds())).toContain(id);
  await page.evaluate(([i, v]) => (window as any).__fake.settle(i, v), [id, value] as const);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
};

/** The picker in one task's row of Advanced. */
const picker = (page: Page, task: string) =>
  page.locator('label').filter({ has: page.getByText(task, { exact: true }) }).getByRole('combobox');

async function openAdvanced(page: Page) {
  await page.getByText('Advanced — choose a model per task').click();
  await expect(page.locator('details')).toHaveAttribute('open', '');
}
async function choose(page: Page, task: string, option: RegExp) {
  await picker(page, task).click();
  await page.getByRole('option', { name: option }).first().click();
}

test('an unrelated settings push before Save keeps the unsaved choice — and Save writes it', async ({ models: page }) => {
  await openAdvanced(page);
  await choose(page, 'Interview answers', /Claude Haiku 5\.5/);
  await expect(picker(page, 'Interview answers')).toHaveText(/Claude Haiku 5\.5/);

  // Same stored overrides, a new map, a changed classifier route (discovery / failover).
  await emit(page, 'onSettingsChanged', snapshot({ effective: { classify: 'anthropic/claude-sonnet-5-5' } }));
  await expect(page.getByText('Question detection: Claude Sonnet 5.5', { exact: false })).toBeVisible(); // it arrived
  await expect(picker(page, 'Interview answers')).toHaveText(/Claude Haiku 5\.5/);
  await expect(page.locator('details')).toHaveAttribute('open', ''); // Advanced stays open

  await page.getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByText('Models saved.')).toBeVisible();
  expect(await setArgs(page)).toEqual([{ modelOverrides: { answer: HAIKU } }]);
});

test('another task changing elsewhere while the answer task is edited: that task refreshes, and Save leaves it alone', async ({ models: page }) => {
  await openAdvanced(page);
  await choose(page, 'Interview answers', /Claude Haiku 5\.5/);

  // The Cue Card moved the solver to Opus meanwhile.
  const OPUS = { coding: 'anthropic/claude-opus-5-5' };
  await emit(page, 'onSettingsChanged', snapshot({ models: OPUS, effective: OPUS }));
  await expect(picker(page, 'Coding solver')).toHaveText(/Claude Opus 5\.5/); // refreshed
  await expect(picker(page, 'Interview answers')).toHaveText(/Claude Haiku 5\.5/); // draft kept

  const saved = snapshot({ models: { ...OPUS, answer: HAIKU }, effective: { ...OPUS, answer: HAIKU } });
  await reply(page, 'settings.set', saved);
  await reply(page, 'settings.get', saved);
  await page.getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByText('Models saved.')).toBeVisible();
  expect(await setArgs(page)).toEqual([{ modelOverrides: { answer: HAIKU } }]); // the solver is not rewritten
  await expect(picker(page, 'Coding solver')).toHaveText(/Claude Opus 5\.5/);
  await expect(picker(page, 'Interview answers')).toHaveText(/Claude Haiku 5\.5/);
});

test('a save that completes after a newer edit leaves the newer draft unsaved — the next Save writes it', async ({ models: page }) => {
  await openAdvanced(page);
  await choose(page, 'Interview answers', /Claude Haiku 5\.5/);
  await reply(page, 'settings.set', { defer: 'first-save' });
  await page.getByRole('button', { name: 'Save models' }).click();

  // Edited again while that save is in flight.
  await choose(page, 'Interview answers', /GPT-6 Luna/);
  const stored = snapshot({ models: { coding: 'gpt-6.2-astra', answer: HAIKU }, effective: { answer: HAIKU } });
  await reply(page, 'settings.get', stored); // the panel re-reads after the save
  await emit(page, 'onSettingsChanged', stored); // main's push for the first save
  await settle(page, 'first-save', stored);
  await expect(picker(page, 'Interview answers')).toHaveText(/GPT-6 Luna/);

  await reply(page, 'settings.set', snapshot({ models: { coding: 'gpt-6.2-astra', answer: 'gpt-6-luna' }, effective: { answer: 'gpt-6-luna' } }));
  await page.getByRole('button', { name: 'Save models' }).click();
  expect(await setArgs(page)).toEqual([{ modelOverrides: { answer: HAIKU } }, { modelOverrides: { answer: 'gpt-6-luna' } }]);
});

test('Save with nothing edited writes nothing and does not claim a save', async ({ models: page }) => {
  await openAdvanced(page);
  await emit(page, 'onSettingsChanged', snapshot({ effective: { classify: 'anthropic/claude-sonnet-5-5' } }));
  await page.getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByText('No model changes to save.')).toBeVisible();
  expect(await setArgs(page)).toEqual([]);
});
