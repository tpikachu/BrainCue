import { test, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';
import { FIXTURE } from './harness/aiFixture';

// UI-03 (M7.2a review, finding 2): the FULL model catalog — OpenAI and
// Anthropic keyed, as in AI-01 — inside compact Cue Cards. It used to measure
// 495 px and clip past 467 and 360 px windows. Real Dropdown, real pointer and
// keyboard input, hidden harness window; no provider, audio or capture.
/* eslint-disable @typescript-eslint/no-explicit-any */

let harness: Harness;
test.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
test.afterAll(async () => harness?.close());

async function cueAt(width: number, height: number) {
  const page = await harness.load('overlay');
  await page.setViewportSize({ width, height });
  await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
  await page.evaluate(() => (window as any).__fake.emit('onSessionState', { status: 'live', paused: false }));
  return page;
}

/** Open More → Interview answers model: the whole catalog. */
async function openCatalog(page: Page) {
  await page.getByRole('button', { name: /More: answer style/ }).click();
  const chip = page.getByLabel('More controls').getByRole('combobox', { name: 'Interview answers model' });
  await chip.click();
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  // It IS the full catalog: rows from both keyed providers.
  await expect(list.getByRole('option', { name: /GPT-6 Luna/ })).toHaveCount(1);
  await expect(list.getByRole('option', { name: /Claude Haiku 5\.5/ })).toHaveCount(1);
  return { chip, list };
}

/** The list, and every row in it, inside the window with an 8 px margin
 *  (1 px rounding) — no horizontal scroll, nothing cut at either edge. */
async function expectListInside(page: Page) {
  const m = await page.evaluate(() => {
    const ul = document.querySelector('[role="listbox"]') as HTMLElement;
    const r = ul.getBoundingClientRect();
    const rows = [...ul.querySelectorAll('[role="option"]')].map((o) => o.getBoundingClientRect());
    return {
      vw: innerWidth,
      vh: innerHeight,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      hScroll: ul.scrollWidth - ul.clientWidth,
      rowsLeft: Math.min(...rows.map((x) => x.left)),
      rowsRight: Math.max(...rows.map((x) => x.right)),
    };
  });
  expect(m.left).toBeGreaterThanOrEqual(7);
  expect(m.right).toBeLessThanOrEqual(m.vw - 7);
  expect(m.top).toBeGreaterThanOrEqual(7);
  expect(m.bottom).toBeLessThanOrEqual(m.vh - 7);
  expect(m.hScroll).toBeLessThanOrEqual(1);
  expect(m.rowsLeft).toBeGreaterThanOrEqual(m.left - 1);
  expect(m.rowsRight).toBeLessThanOrEqual(m.right + 1);
  return m;
}

const setArgs = (page: Page) =>
  page.evaluate(() => (window as any).__fake.args.filter((a: any) => a.path === 'settings.set').map((a: any) => a.args[0]));

for (const [w, h] of [
  [467, 462],
  [360, 462],
] as const) {
  test(`the full catalog fits a ${w} × ${h} Cue Card, wraps long rows, and every choice is reachable`, async () => {
    const page = await cueAt(w, h);
    const { chip, list } = await openCatalog(page);
    await expectListInside(page);

    // Keyboard: End reaches the last row, and it is scrolled into the list.
    await chip.focus();
    await page.keyboard.press('End');
    const lastId = await chip.getAttribute('aria-activedescendant');
    expect(lastId).toBeTruthy();
    const last = await page.locator(`[id="${lastId}"]`).boundingBox();
    const box = (await list.boundingBox())!;
    expect(last!.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(last!.y + last!.height).toBeLessThanOrEqual(box.y + box.height + 1);

    // Pointer: a row well down the list is chosen, with its whole name shown.
    const haiku = list.getByRole('option', { name: /Claude Haiku 5\.5/ });
    await haiku.scrollIntoViewIfNeeded();
    await expect(haiku).toContainText('Claude Haiku 5.5');
    await haiku.click();
    await expect(list).toHaveCount(0);
    expect((await setArgs(page)).at(-1)).toEqual({ modelOverrides: { answer: 'anthropic/claude-haiku-5-5' } });
  });
}

test('an open catalog is placed again when the Cue Card is resized', async () => {
  const page = await cueAt(467, 462);
  await openCatalog(page);
  await expectListInside(page);
  await page.setViewportSize({ width: 360, height: 462 });
  await expect.poll(async () => (await expectListInside(page).then(() => 'inside').catch((e) => String(e)))).toBe('inside');
  await page.setViewportSize({ width: 520, height: 462 });
  await expect.poll(async () => (await expectListInside(page).then(() => 'inside').catch((e) => String(e)))).toBe('inside');
  // Still a working list after both resizes: Escape closes it, not More.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByLabel('More controls')).toBeVisible();
});

test('positive controls: a wide window keeps the catalog compact, and a wide control is never narrower than its list', async () => {
  const page = await cueAt(1100, 900);
  await openCatalog(page);
  const m = await expectListInside(page);
  expect(m.right - m.left).toBeLessThanOrEqual(22 * 16 + 1); // its 22rem cap, not stretched
  await page.keyboard.press('Escape');

  // A control wider than that cap (the Start dialog's Space picker): the
  // list is at least as wide as the control, and still inside the window.
  const start = await harness.load('startModal');
  await start.setViewportSize({ width: 1100, height: 900 });
  await start.evaluate(() => (window as any).__harness.open('A'));
  const dialog = start.getByRole('dialog', { name: 'Start an interview' });
  const box = dialog.getByRole('combobox').first();
  await expect(box).toContainText('Backend Engineer');
  await box.click();
  await expect(start.getByRole('listbox')).toBeVisible();
  const control = (await box.boundingBox())!;
  const ml = await expectListInside(start);
  expect(ml.right - ml.left).toBeGreaterThanOrEqual(control.width - 1);
});
