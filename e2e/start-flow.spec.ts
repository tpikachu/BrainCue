import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * The start flow's ROLE CHOICE, in the real app (main + SQLite + the actual
 * StartSessionModal). No key and no model call: roles are saved without a job
 * description to parse, and Start is never pressed — nothing is captured.
 *
 * The bug this pins (M5 review): the picker loads one page of 100 roles, and
 * a role handed in (or remembered from the last interview) that was not on
 * that page was treated as deleted and silently replaced by another role —
 * whose id and JD would then have been used for the interview.
 */

test.use({ noApiKey: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
const profileInput = (name: string) => ({
  name,
  targetRole: 'SWE',
  targetCompany: null,
  interviewType: 'general',
  language: 'en',
  resumeText: null,
  jdText: null,
});

const roleRow = (dialog: Locator) => dialog.locator('li', { hasText: 'Role & JD' }).first();
const picker = (dialog: Locator) => dialog.locator('button[aria-haspopup="listbox"]').first();

async function openStart(page: Page): Promise<Locator> {
  await page.evaluate(() => (location.hash = '#/home'));
  await page.getByRole('button', { name: 'Start interview' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Start an interview/ });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Start an interview/ })).toHaveCount(0);
}

test('an older role (beyond the first page) stays chosen; deleted and other-profile roles never reach Start', async ({ dashboard: page }) => {
  // ---- seed: profile A with 101 roles; profile B with one ----
  const seeded = await page.evaluate(async (inputs) => {
    const api = (window as any).api;
    const a = await api.profiles.create(inputs.a);
    const b = await api.profiles.create(inputs.b);
    for (let i = 1; i <= 101; i++) {
      await api.jobs.save({
        profileId: a.id,
        kind: 'job',
        title: `Role ${String(i).padStart(3, '0')}`,
        company: 'Acme',
        jdUrl: null,
        jdText: null,
        companyUrl: null,
        notes: null,
      });
    }
    await api.jobs.save({ profileId: b.id, kind: 'job', title: 'B only role', company: 'Globex', jdUrl: null, jdText: null, companyUrl: null, notes: null });
    // Which roles are NOT on the picker's first page (asked of main, not assumed).
    const first = await api.jobs.page(a.id, '', 100, 0, 'job');
    const onPage = new Set(first.items.map((j: any) => j.id));
    const list = await api.jobs.list(a.id);
    const older = list.filter((j: any) => !onPage.has(j.id));
    await api.settings.set({ activeProfileId: a.id, onboardingDone: true, tourDone: true });
    return { a: a.id, b: b.id, total: first.total, older: older.map((j: any) => ({ id: j.id, title: j.title })) };
  }, { a: profileInput('Role Tester A'), b: profileInput('Role Tester B') });
  expect(seeded.total).toBe(101);
  expect(seeded.older).toHaveLength(1);
  const older = seeded.older[0];
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start interview' }).first()).toBeVisible();

  await test.step('explicit: Start on that role in the Interview list opens the flow with IT chosen', async () => {
    await page.evaluate(() => (location.hash = '#/interview'));
    await page.getByPlaceholder('Search interviews by role or client…').fill(older.title);
    const row = page.locator('tr', { hasText: older.title });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Start' }).click();
    const dialog = page.getByRole('dialog', { name: /Start an interview/ });
    await expect(roleRow(dialog)).toContainText(older.title);
    await expect(picker(dialog)).toContainText(older.title);
    // Settles, and is still that role (the page loading must not replace it).
    await page.waitForTimeout(1200);
    await expect(roleRow(dialog)).toContainText(older.title);
    await closeDialog(page);
  });

  await test.step('search: an older role is reachable from the picker', async () => {
    const dialog = await openStart(page);
    // No history and several roles: no guess.
    await expect(roleRow(dialog)).toContainText('choose the role above');
    await dialog.getByPlaceholder('Search older roles by title or company…').fill(older.title);
    await page.waitForTimeout(600); // debounce + query
    await picker(dialog).click();
    await page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: older.title }).first().click();
    await expect(roleRow(dialog)).toContainText(older.title);
    await closeDialog(page);
  });

  await test.step('last used: an interview in the older role makes it the default', async () => {
    await page.evaluate(async ({ pid, jid }) => {
      const api = (window as any).api;
      const s = await api.session.start(pid, 'general', jid, 'general', 'job');
      await api.session.stop(s.id);
    }, { pid: seeded.a, jid: older.id });
    // The save prompt for that (empty) session: decide later — it keeps the row.
    const later = page.getByRole('button', { name: 'Decide later' });
    if (await later.isVisible().catch(() => false)) await later.click();
    const dialog = await openStart(page);
    await expect(roleRow(dialog)).toContainText(older.title);
    await page.waitForTimeout(1200);
    await expect(roleRow(dialog)).toContainText(older.title);
    await closeDialog(page);
  });

  await test.step('deleted: the remembered role is gone, so it is not the default', async () => {
    await page.evaluate(async (jid) => (window as any).api.jobs.delete(jid), older.id);
    const dialog = await openStart(page);
    await expect(roleRow(dialog)).toContainText('choose the role above');
    await expect(picker(dialog)).not.toContainText(older.title);
    await closeDialog(page);
  });

  await test.step("profile switch: B's own role, never one of A's", async () => {
    await page.locator('button[aria-haspopup="listbox"]').first().click(); // the sidebar profile switcher
    await page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: 'Role Tester B' }).first().click();
    const dialog = await openStart(page);
    await expect(roleRow(dialog)).toContainText('B only role');
    await expect(picker(dialog)).not.toContainText('Acme');
    await closeDialog(page);
  });
});
