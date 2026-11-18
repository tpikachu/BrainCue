import { test as base, expect, type Page } from '@playwright/test';
import { calls, launchHarness, type Harness } from './harness/harness';

/**
 * The REAL StartSessionModal under controlled timing (M5 review): a role
 * lookup still in flight must never overwrite a NEWER choice. And (M6)
 * Resume comes through the same flow: setup, readiness and the disclosure,
 * then the SAME session continues — never a new start.
 *
 * Runs in the renderer harness (harness/harness.ts): the modal's bundle in
 * one hidden Electron window against a fake bridge whose `jobs.get` replies
 * the test holds and releases; startNew / resumeExisting record what they
 * were asked to start. Each case asserts that submitted id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const parsedResume = { skills: ['TS'], projects: [], workHistory: [], metrics: [], education: [], certifications: [], techStack: [], leadership: [] };
const parsedJd = { requirements: ['x'], responsibilities: [], keywords: [], focusAreas: [] };
const role = (id: string, profileId: string) => ({
  id,
  profileId,
  kind: 'job',
  title: `Role ${id}`,
  company: 'Acme',
  jdText: 'JD',
  parsedJd,
  updatedAt: 1,
});
const FIXTURE = {
  profiles: [
    { id: 'pA', name: 'Alex', parsedResume, resumeText: 'x' },
    { id: 'pB', name: 'Sam', parsedResume, resumeText: 'x' },
  ],
  roles: [role('A', 'pA'), role('B', 'pA'), role('C', 'pB'), role('D', 'pA')],
  /** Alex last interviewed for D — so with no role handed in, D is the default. */
  sessions: { pA: [{ id: 's1', kind: 'live', mode: 'interview', activity: 'job', jobId: 'D' }] } as Record<string, unknown[]>,
  details: { s1: { id: 's1', transcript: [{ id: 't1', speaker: 'interviewer', text: 'Tell me about yourself.' }], questions: [], cards: [] } },
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'Anthropic · Claude Sonnet 5.5 — why' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
    features: { parsing: { ready: true }, mock: { ready: true }, sparring: { ready: true }, tailoring: { ready: true } },
  },
};

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());

/** A fresh load per case: the fake and the bundle start over. */
const test = base.extend<{ hpage: Page }>({
  hpage: async ({}, use) => use(await harness.load('startModal')),
});

const dialog = (page: Page) => page.getByRole('dialog', { name: /Start an interview|Resume the interview/ });
const roleRow = (page: Page) => dialog(page).locator('li', { hasText: 'Role & JD' }).first();
const startBtn = (page: Page) => dialog(page).getByRole('button', { name: 'Start interview' });
const h = (page: Page, js: string) => page.evaluate(js);
/** The job ids Start submitted, in order. */
const starts = (page: Page) => page.evaluate(() => (window as any).__fake.starts as (string | null)[]);
const waitGet = (page: Page, id: string) => page.waitForFunction((x) => (window as any).__fake.gets.includes(x), id);
/** Choose an open Dropdown option with a real pointer click. (Through M5 this
 *  was a dispatched click: an option was a button that took focus, and the
 *  hidden window's blur closed the list first. Options now keep focus on the
 *  combobox, and the harness proves each page takes input.) */
const pickOption = (page: Page, label: string) =>
  page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: label }).first().click();

test('baseline: a role handed in is chosen, and Start submits it', async ({ hpage: page }) => {
  await h(page, `__harness.open('A')`);
  await expect(roleRow(page)).toContainText('Role A');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['A']);
});

test("A's lookup held, closed, reopened for B: A's late reply never replaces B", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.close()`);
  await expect(dialog(page)).toHaveCount(0);
  await h(page, `__harness.open('B')`);
  await expect(roleRow(page)).toContainText('Role B');
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});

test("A's lookup held, B chosen in the picker: A's late reply never replaces B", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await dialog(page).locator('button[aria-haspopup="listbox"]').first().click();
  await pickOption(page, 'Role B');
  await expect(roleRow(page)).toContainText('Role B');
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});

test("profile switched while A's lookup is pending: the new profile's role, never A", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.setProfile('pB')`);
  await expect(roleRow(page)).toContainText('Role C'); // Sam's only role
  await h(page, `__fake.release('A')`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).toContainText('Role C');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['C']);
});

test("a stale lookup's failure and finalisation do not end the CURRENT lookup", async ({ hpage: page }) => {
  await h(page, `__fake.hold('A'); __harness.open('A')`);
  await waitGet(page, 'A');
  await h(page, `__harness.close()`);
  await h(page, `__fake.hold('B'); __harness.open('B')`);
  await waitGet(page, 'B');
  // A fails late while B's lookup is still pending. If A's finalisation ended
  // "resolving" for B's opening, the default (Alex's last role, D) would be
  // applied and Start enabled for D before B's reply arrived.
  await h(page, `__fake.release('A', true)`);
  await page.waitForTimeout(300);
  await expect(roleRow(page)).not.toContainText('Role D');
  await expect(startBtn(page)).toBeDisabled();
  await h(page, `__fake.release('B')`);
  await expect(roleRow(page)).toContainText('Role B');
  await startBtn(page).click();
  await expect.poll(() => starts(page)).toEqual(['B']);
});

// ---- M6: Resume through the start flow ----------------------------------------

const resumeItem = { id: 's1', profileId: 'pA', jobId: 'D', kind: 'live', mode: 'interview', activity: 'job', createdAt: Date.UTC(2026, 10, 10) };

test('Resume shows setup, readiness and the disclosure, then continues the SAME session (never a new start)', async ({ hpage: page }) => {
  await page.evaluate((s) => (window as any).__harness.resume(s), resumeItem);
  const d = dialog(page);
  await expect(d).toHaveAttribute('aria-label', 'Resume the interview');
  await expect(d).toContainText('Continuing the round from');
  await expect(d).toContainText('its transcript is restored and kept');
  await expect(roleRow(page)).toContainText('Role D'); // its own role
  await expect(d.locator('li', { hasText: 'AI' }).first()).toBeVisible(); // readiness rows
  await expect(d.locator('summary')).toContainText('what is captured and sent'); // disclosure
  // Nothing is captured before the explicit press.
  expect(await page.evaluate(() => (window as any).__fake.resumes)).toEqual([]);
  await d.getByRole('button', { name: 'Resume interview' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fake.resumes)).toEqual(['s1']);
  expect(await starts(page)).toEqual([]);
  expect(await calls(page)).toContain('session.get'); // its transcript, restored
});

test("Resume of another profile's interview is blocked, with why", async ({ hpage: page }) => {
  await page.evaluate((s) => (window as any).__harness.resume({ ...s, profileId: 'pB' }), resumeItem);
  const d = dialog(page);
  await expect(d.getByRole('alert')).toContainText('belongs to another profile');
  await expect(d.getByRole('button', { name: 'Resume interview' })).toBeDisabled();
});
