import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';
import { FIXTURE, SETTINGS, snapshot } from './harness/aiFixture';

// M7.2a review, AI-01 finding 1: settings replies that land late. The real
// Cue Card and Cue Card settings (renderer harness: hidden window, fake
// bridge, capture refused, no provider). A held read or write reply must
// never put back an older model than the one shown, and an edit of one field
// must never write another field from a stale copy.
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
const reply = (page: Page, path: string, value: unknown) =>
  page.evaluate(([p, v]) => ((window as any).__fake.replies[p] = v), [path, value] as const);
/** Release a deferred reply — once the page has actually asked for it. */
async function settle(page: Page, id: string, value: unknown) {
  await expect.poll(() => page.evaluate(() => (window as any).__fake.deferredIds())).toContain(id);
  await page.evaluate(([i, v]) => (window as any).__fake.settle(i, v), [id, value] as const);
  // Let the released reply reach React before asserting it changed nothing.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
}
const setArgs = (page: Page) =>
  page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'settings.set').map((a: any) => a.args[0]));

const HAIKU = snapshot({ models: { coding: 'gpt-6.2-astra', answer: 'anthropic/claude-haiku-5-5' }, effective: { answer: 'anthropic/claude-haiku-5-5' } });
const SONNET_SOLVER = snapshot({ models: { coding: 'anthropic/claude-sonnet-5-5' }, effective: { coding: 'anthropic/claude-sonnet-5-5' } });

const openMore = async (page: Page) => {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  return page.getByLabel('More controls');
};
async function openSettings(page: Page) {
  const tray = await openMore(page);
  await tray.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Cue Card settings' });
}

test('a read that lands after a newer push leaves the Interview answers chip on the newer model', async ({ cue: page }) => {
  await reply(page, 'settings.get', { defer: 'old-read' });
  await emit(page, 'onAnswerPrefs', { interviewType: 'general', format: 'general', pronunciation: false }); // re-reads settings
  await emit(page, 'onSettingsChanged', HAIKU); // newer: answers moved to Haiku
  const tray = await openMore(page);
  const chip = tray.getByRole('combobox', { name: 'Interview answers model' });
  await expect(chip).toHaveText(/Claude Haiku 5\.5/);

  await settle(page, 'old-read', SETTINGS); // the read, from before the change
  await expect(chip).toHaveText(/Claude Haiku 5\.5/);
  await expect(chip).not.toHaveText(/Sonnet/);
});

test('of two picks in flight, the later one stays on the chip whichever reply lands last — each writes only its task', async ({ cue: page }) => {
  await emit(page, 'onAnswerPrefs', { interviewType: 'general', format: 'general', pronunciation: false });
  const tray = await openMore(page);
  const chip = tray.getByRole('combobox', { name: 'Interview answers model' });
  await expect(chip).toHaveText(/Claude Sonnet 5\.5/);
  const LUNA = snapshot({ models: { coding: 'gpt-6.2-astra', answer: 'gpt-6-luna' }, effective: { answer: 'gpt-6-luna' } });
  await reply(page, 'settings.set', [{ defer: 'first-pick' }, LUNA]);

  await chip.click();
  await page.getByRole('option', { name: /^(Anthropic )?Claude Haiku 5\.5 / }).click();
  await chip.click();
  await page.getByRole('option', { name: /^(OpenAI )?GPT-6 Luna / }).click();
  await expect(chip).toHaveText(/GPT-6 Luna/);

  await settle(page, 'first-pick', HAIKU);
  await expect(chip).toHaveText(/GPT-6 Luna/);
  expect(await setArgs(page)).toEqual([
    { modelOverrides: { answer: 'anthropic/claude-haiku-5-5' } },
    { modelOverrides: { answer: 'gpt-6-luna' } },
  ]);
});

test('Cue Card settings: a read held across close and reopen never restores the old solver, and an effort-only edit writes only the effort', async ({ cue: page }) => {
  await reply(page, 'settings.get', { defer: 'first-open' });
  let dialog = await openSettings(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Changed elsewhere meanwhile (the dashboard): the solver moves to Sonnet.
  await emit(page, 'onSettingsChanged', SONNET_SOLVER);
  await reply(page, 'settings.get', SONNET_SOLVER);
  dialog = await openSettings(page);
  const model = dialog.getByRole('combobox', { name: 'Coding solver model' });
  await expect(model).toHaveText(/Claude Sonnet 5\.5/);

  await settle(page, 'first-open', SETTINGS); // the first open's read, from before the change
  await expect(model).toHaveText(/Claude Sonnet 5\.5/);
  await expect(model).not.toHaveText(/Astra/);

  // Change ONLY the reasoning effort. (Main's reply: the state after its merge.)
  await reply(page, 'settings.set', snapshot({ models: { coding: 'anthropic/claude-sonnet-5-5' }, efforts: { coding: 'high' }, effective: { coding: 'anthropic/claude-sonnet-5-5' } }));
  const effort = dialog.getByRole('combobox').last(); // Reasoning effort
  await expect(effort).toHaveText(/^Default \(low\)/);
  await effort.click();
  await page.getByRole('option', { name: /^High/ }).click();
  await expect(effort).toHaveText(/^High/);
  // Exactly the edited field — no model, no provider, nothing from this copy.
  expect((await setArgs(page)).at(-1)).toEqual({ effortOverrides: { coding: 'high' } });
  await expect(model).toHaveText(/Claude Sonnet 5\.5/);
});

test('Cue Card settings: a model save that completes after a later effort save keeps both choices', async ({ cue: page }) => {
  const dialog = await openSettings(page);
  const model = dialog.getByRole('combobox', { name: 'Coding solver model' });
  await expect(model).toHaveText(/GPT-6\.2 Astra/);
  const BOTH = snapshot({ models: { coding: 'anthropic/claude-sonnet-5-5' }, efforts: { coding: 'high' }, effective: { coding: 'anthropic/claude-sonnet-5-5' } });
  await reply(page, 'settings.set', [{ defer: 'model-save' }, BOTH]);

  await model.click();
  await page.getByRole('option', { name: /^(Anthropic )?Claude Sonnet 5\.5 / }).click();
  const effort = dialog.getByRole('combobox').last(); // Reasoning effort
  await expect(effort).toHaveText(/^Default \(low\)/);
  await effort.click();
  await page.getByRole('option', { name: /^High/ }).click();
  await expect(effort).toHaveText(/^High/);

  // The model save's reply, from before the effort was saved, lands last.
  await settle(page, 'model-save', SONNET_SOLVER);
  await expect(effort).toHaveText(/^High/); // effort not reverted
  await expect(model).toHaveText(/Claude Sonnet 5\.5/);
  expect(await setArgs(page)).toEqual([
    { modelOverrides: { coding: 'anthropic/claude-sonnet-5-5' } },
    { effortOverrides: { coding: 'high' } },
  ]);
});
