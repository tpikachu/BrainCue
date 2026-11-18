import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';

/**
 * M6 — shared modal and dropdown behaviour, on the REAL role form and start
 * flow (renderer harness: hidden Electron window, fake bridge). Driven by
 * the keyboard only: focus stays inside a dialog and comes back on close; a
 * dropdown answers arrows / Home / End / Enter / Escape with its state
 * exposed; Escape closes the inner control first; an edited draft is never
 * dropped by an accidental Escape, backdrop or ×; a save in flight is not
 * silently abandoned; and a readiness row's detail is reachable by keyboard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const parsedJd = { requirements: ['x'], responsibilities: [], keywords: [], focusAreas: [] };
const role = (id: string, title: string) => ({ id, profileId: 'pA', kind: 'job', title, company: 'Acme', jdText: 'JD', parsedJd, updatedAt: 1 });
const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex', parsedResume: { skills: ['TS'] }, resumeText: 'x' }],
  roles: [role('A', 'Alpha role'), role('B', 'Beta role'), role('C', 'Gamma role'), role('D', 'Delta role')],
  sessions: { pA: [] },
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'Anthropic · Claude Sonnet 5.5 — answers your questions' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical', note: 'Documents are matched by keywords.' },
    routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
    features: {},
  },
};

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());
const test = base.extend<{ form: Page; start: Page }>({
  form: async ({}, use) => use(await harness.load('jobForm')),
  start: async ({}, use) => use(await harness.load('startModal')),
});

const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { tag: el?.tagName ?? '', text: (el?.getAttribute('aria-label') || el?.textContent || '').trim().slice(0, 40), inDialog: !!el?.closest('[role="dialog"]') };
  });
const openForm = async (page: Page) => {
  await page.locator('#opener').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New role' })).toBeVisible();
};

// ------------------------------------------------------------------ focus ----

test('focus moves into the dialog, Tab / Shift+Tab wrap inside it, and it returns to the opener on close', async ({ form: page }) => {
  await openForm(page);
  expect((await active(page)).inDialog).toBe(true);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect((await active(page)).inDialog).toBe(true);
  }
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Shift+Tab');
    expect((await active(page)).inDialog).toBe(true);
  }
  await page.keyboard.press('Escape'); // clean form: closes at once
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await active(page)).text).toBe('Open the role form');
});

// ----------------------------------------------------------------- drafts ----

test('an edited draft survives an accidental Escape, × or backdrop; Keep editing returns to it; Discard is explicit', async ({ form: page }) => {
  await openForm(page);
  const d = page.getByRole('dialog', { name: 'New role' });
  const name = d.locator('input').first();
  await name.fill('Platform Engineer');
  // Escape
  await page.keyboard.press('Escape');
  const ask = d.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  expect((await active(page)).text).toBe('Keep editing'); // the safe choice has focus
  await page.keyboard.press('Enter');
  await expect(ask).toHaveCount(0);
  await expect(name).toHaveValue('Platform Engineer');
  // ×
  await d.getByRole('button', { name: 'Close' }).click();
  await expect(ask).toBeVisible();
  await page.keyboard.press('Escape'); // Escape closes the question, not the dialog
  await expect(ask).toHaveCount(0);
  await expect(d).toBeVisible();
  // Backdrop
  await page.mouse.click(5, 5);
  await expect(ask).toBeVisible();
  // The form's own Cancel goes through the same guard.
  await d.getByRole('button', { name: 'Keep editing' }).click();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeVisible();
  await d.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Reopened: a fresh form.
  await openForm(page);
  await expect(page.getByRole('dialog').locator('input').first()).toHaveValue('');
});

test('a save in flight is not silently abandoned: dismissal is refused and said', async ({ form: page }) => {
  await page.evaluate(() => ((window as any).__fake.replies['jobs.save'] = { hold: true }));
  await openForm(page);
  const d = page.getByRole('dialog', { name: 'New role' });
  await d.locator('input').first().fill('Platform Engineer');
  await d.getByRole('button', { name: 'Create' }).click();
  await page.keyboard.press('Escape');
  await expect(d.getByRole('status')).toContainText('Saving — this stays open until it finishes');
  await d.getByRole('button', { name: 'Close' }).click();
  await expect(d).toBeVisible();
  await expect(d.locator('input').first()).toHaveValue('Platform Engineer');
});

// --------------------------------------------------------------- dropdown ----

test('dropdown: arrows / Home / End move, Enter chooses, with its state exposed — keyboard only', async ({ start: page }) => {
  await page.evaluate(() => (window as any).__harness.open('A'));
  const d = page.getByRole('dialog', { name: 'Start an interview' });
  const box = d.getByRole('combobox').first();
  await expect(box).toContainText('Alpha role');
  await box.focus();
  await page.keyboard.press('ArrowDown'); // opens on the current choice
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  const activeOption = async () => {
    const id = await box.getAttribute('aria-activedescendant');
    return id ? page.locator(`[id="${id}"]`).innerText() : '';
  };
  expect(await activeOption()).toContain('Alpha role');
  await page.keyboard.press('ArrowDown');
  expect(await activeOption()).toContain('Beta role');
  await page.keyboard.press('End');
  expect(await activeOption()).toContain('Delta role');
  await page.keyboard.press('Home');
  expect(await activeOption()).toMatch(/Choose a role/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toContainText('Beta role');
  await expect(d.locator('li', { hasText: 'Role & JD' }).first()).toContainText('Beta role');
  // Type-ahead.
  await page.keyboard.press('Space');
  await page.keyboard.press('g');
  expect(await activeOption()).toContain('Gamma role');
  await page.keyboard.press('Enter');
  await expect(box).toContainText('Gamma role');
});

test('Escape closes the open dropdown first, then the dialog', async ({ start: page }) => {
  await page.evaluate(() => (window as any).__harness.open('A'));
  const d = page.getByRole('dialog', { name: 'Start an interview' });
  const box = d.getByRole('combobox').first();
  await box.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(box).toContainText('Alpha role'); // nothing chosen by closing
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});

test("a readiness row's detail is reachable by keyboard, not only on hover", async ({ start: page }) => {
  await page.evaluate(() => (window as any).__harness.open('A'));
  const d = page.getByRole('dialog', { name: 'Start an interview' });
  const ai = d.locator('li', { has: page.getByText('AI', { exact: true }) });
  await expect(ai).toHaveAttribute('tabindex', '0');
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await ai.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await expect(page.getByRole('tooltip')).toContainText('answers your questions');
});
