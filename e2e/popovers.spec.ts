import { test as base, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';

// Real controls in a hidden Electron window: no app main, audio, provider or
// desktop capture. Exercise geometry and actual pointer/keyboard events.
/* eslint-disable @typescript-eslint/no-explicit-any */
const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex', parsedResume: { skills: ['TS'] }, resumeText: 'Resume' }],
  roles: [{ id: 'A', profileId: 'pA', kind: 'job', title: 'Backend Engineer', company: 'Acme', jdText: 'JD', parsedJd: { requirements: ['TS'] } }],
  sessions: { pA: [] },
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'Ready' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
    features: {},
  },
};

let harness: Harness;
base.beforeAll(async () => { harness = await launchHarness(FIXTURE); });
base.afterAll(async () => harness?.close());
const test = base.extend<{ cue: Page; start: Page }>({
  cue: async ({}, use) => {
    const page = await harness.load('overlay');
    await page.setViewportSize({ width: 467, height: 462 });
    await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
    await page.evaluate(() => {
      (window as any).__fake.emit('onSessionState', { status: 'live', paused: false });
      (window as any).__fake.emit('onCaptureStatus', { system: true, mic: true, wantsSystem: true });
    });
    await use(page);
  },
  start: async ({}, use) => {
    const page = await harness.load('startModal');
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate(() => (window as any).__harness.open('A'));
    await use(page);
  },
});

async function expectInsideWindow(page: Page, role: 'tooltip' | 'listbox') {
  const popup = page.getByRole(role);
  await expect(popup).toBeVisible();
  const rect = await popup.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(7);
  expect(rect!.y).toBeGreaterThanOrEqual(7);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width - 7);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height - 7);
}

test('the full Answer that tooltip fits at the bottom-left of a compact Cue Card', async ({ cue: page }) => {
  await page.getByRole('button', { name: 'Answer that', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText("when it wasn't picked up as a question");
  await expectInsideWindow(page, 'tooltip');
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(page.getByRole('tooltip')).toHaveCount(0); // pointer-only tips still dismiss
});

test('a tooltip at the right edge stays inside the window, including after resize', async ({ cue: page }) => {
  const hide = page.getByRole('button', { name: 'Hide Cue Card', exact: true });
  await hide.hover();
  await expectInsideWindow(page, 'tooltip');
  await page.setViewportSize({ width: 360, height: 300 });
  await page.mouse.move(1, 150);
  await hide.focus();
  await expectInsideWindow(page, 'tooltip');
});

test('clicking elsewhere inside a dialog dismisses its dropdown without changing the choice', async ({ start: page }) => {
  const dialog = page.getByRole('dialog', { name: 'Start an interview' });
  const box = dialog.getByRole('combobox').first();
  await expect(box).toContainText('Backend Engineer');
  await box.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await dialog.getByRole('heading', { name: 'Start an interview' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(box).toContainText('Backend Engineer');
  await expect(dialog).toBeVisible();
});

test('the compact model list fits the window and still supports choosing an option', async ({ cue: page }) => {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  const box = page.getByLabel('More controls').getByRole('combobox');
  await box.focus();
  await page.keyboard.press('ArrowDown');
  await expectInsideWindow(page, 'listbox');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('More dismisses on an outside click, Escape and window blur', async ({ cue: page }) => {
  const more = page.getByRole('button', { name: /More: answer style|Hide more/ });
  await more.click();
  await page.getByPlaceholder('Or type a question…').click();
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await more.click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await more.click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await more.click();
  await more.click();
  await expect(page.getByLabel('More controls')).toHaveCount(0);
});

test('Escape dismisses the model list before More; an outside press inside More closes only the list', async ({ cue: page }) => {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  const tray = page.getByLabel('More controls');
  const box = tray.getByRole('combobox');
  await box.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(tray).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await tray.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(tray).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tray).toHaveCount(0);
});

test('opening settings replaces More and Escape closes the settings dialog first', async ({ cue: page }) => {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  await page.getByLabel('More controls').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Cue Card settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('click-through waits until the open controls have received their outside click', async ({ cue: page }) => {
  await page.getByRole('button', { name: /Click-through \(mouse passes through\)/ }).click();
  const more = page.getByRole('button', { name: /More: answer style|Hide more/ });
  await more.click();
  await page.evaluate(() => { (window as any).__fake.args = []; });
  await page.mouse.move(230, 340);
  const ignored = () => page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'overlay.setClickthrough' && a.args[0] === true));
  expect(await ignored()).toEqual([]);
  await page.mouse.click(230, 340);
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await page.mouse.move(231, 341);
  await expect.poll(ignored).not.toEqual([]);
});
