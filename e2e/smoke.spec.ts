import { test, expect, type Page } from './fixtures';

/**
 * Smoke: the REAL app (main + SQLite + every page), OFFLINE — no key, no
 * network, no capture (the fixture's guard). It launches, a fresh install
 * opens first-run setup, and with a profile every section renders and the
 * interview start flow says what it needs without starting anything.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A profile, chosen in the sidebar, with first-run setup finished — what a
 *  returning user has. Reloads so the app reads it from the start. */
async function withProfile(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const api = (window as any).api;
    const p = await api.profiles.create({ name: 'Smoke Tester', targetRole: 'SWE', targetCompany: null, interviewType: 'general', language: 'en', resumeText: null, jdText: null });
    await api.settings.set({ activeProfileId: p.id, onboardingDone: true, tourDone: true });
    return p.id as string;
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  return id;
}
const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('link', { name, exact: true });

test('a fresh install opens first-run setup, and nothing else', async ({ dashboard: page }) => {
  const setup = page.getByRole('dialog', { name: 'Set up BrainCue' });
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Welcome to BrainCue' })).toBeVisible();
  await expect(setup.getByRole('list', { name: 'Setup steps' })).toBeVisible();
});

test('with a profile: the shell and its sections', async ({ dashboard: page }) => {
  await withProfile(page);
  for (const name of ['Home', 'Library', 'Sessions', 'Insights', 'Profiles', 'Settings']) {
    await expect(nav(page, name)).toBeVisible();
  }
  await expect(page.getByRole('dialog', { name: 'Set up BrainCue' })).toHaveCount(0);
});

test('Home: Start interview opens the start flow, which says what is missing and starts nothing', async ({ dashboard: page }) => {
  await withProfile(page);
  await nav(page, 'Home').click();
  await expect(page.getByRole('heading', { name: 'Interview Copilot' })).toBeVisible();
  await page.getByRole('button', { name: 'Start interview' }).first().click();
  const d = page.getByRole('dialog', { name: 'Start an interview' });
  await expect(d).toBeVisible();
  // Readiness from main, row by row: no key → the AI row is blocked; no résumé, no role.
  const row = (label: string) => d.locator('li').filter({ has: page.getByText(label, { exact: true }) }).first();
  await expect(row('AI')).toContainText('no OpenAI key (answers, question detection)');
  await expect(row('Audio')).toContainText('cloud transcription needs an OpenAI key');
  await expect(row('Résumé')).toContainText('not added yet');
  await expect(d.getByRole('button', { name: 'Start interview' })).toBeDisabled();
  // The disclosure is there before anything is captured.
  await expect(d.locator('summary')).toContainText('what is captured and sent');
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  const live = await page.evaluate(async () => (await (window as any).api.session.list((await (window as any).api.settings.get()).activeProfileId)).length);
  expect(live).toBe(0);
});

test('Interviews: the role list, its New role action, and why a round cannot start yet', async ({ dashboard: page }) => {
  await withProfile(page);
  await page.evaluate(() => (location.hash = '#/interview'));
  await expect(page.getByRole('heading', { name: 'Interviews' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New role' })).toBeVisible();
  await expect(page.getByText('No roles yet.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('⚠');
});

test('Library: Spaces and Documents tabs', async ({ dashboard: page }) => {
  await withProfile(page);
  await nav(page, 'Library').click();
  const tabs = page.getByRole('tablist', { name: 'Library sections' });
  await expect(tabs.getByRole('tab', { name: 'Spaces' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Documents' }).click();
  await expect(tabs.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=documents/);
});

test('Sessions and Insights are separate sections; history starts empty', async ({ dashboard: page }) => {
  await withProfile(page);
  await nav(page, 'Sessions').click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('No sessions yet.')).toBeVisible();
  await nav(page, 'Insights').click();
  await expect(page.getByRole('heading', { name: 'Insights' })).toBeVisible();
});

test('Settings: the bare route lands on Preferences; AI providers show none configured', async ({ dashboard: page }) => {
  await withProfile(page);
  await nav(page, 'Settings').click();
  await expect(page).toHaveURL(/#\/settings\/preferences$/);
  await page.evaluate(() => (location.hash = '#/settings/models'));
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  const keys = await page.evaluate(async () => (await (window as any).api.settings.get()).providerKeys);
  expect(Object.values(keys ?? {}).filter(Boolean)).toEqual([]);
});
