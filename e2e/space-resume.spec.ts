import { test, expect, type Page } from '@playwright/test';
import { launchHarness, type Harness } from './harness/harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
const role = { id: 'r1', profileId: 'p1', kind: 'job', title: 'Engineer', company: null, jdText: null, resumeText: 'Role-specific résumé.', tailoredResume: null };
let harness: Harness;
test.beforeAll(async () => { harness = await launchHarness({ profiles: [{ id: 'p1', name: 'Alex', resumeText: 'Default résumé.' }], roles: [role] }); });
test.afterAll(async () => { await harness?.close(); });

async function open() {
  const page = await harness.load('jobForm');
  await page.evaluate(() => {
    (window as any).__fake.replies['jobs.save'] = { job: { id: 'r1' } };
    (window as any).__fake.replies['jobs.setCompanionPrefs'] = { id: 'r1' };
  });
  await page.locator('#opener').click();
  await page.getByRole('dialog').locator('input').first().fill('Engineer');
  return page;
}
async function savedResume(page: Page) {
  return page.evaluate(() => (window as any).__fake.args.filter((c: any) => c.path === 'jobs.save').at(-1)?.args[0].resumeText);
}

async function chooseResume(page: Page, own: boolean) {
  await page.getByRole('combobox', { name: 'Résumé for this role' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(own ? 'End' : 'Home');
  await page.keyboard.press('Enter');
}

test('a new role defaults to the profile résumé and saves an explicit default choice', async () => {
  const page = await open();
  await expect(page.getByRole('combobox', { name: 'Résumé for this role' })).toContainText('Default résumé');
  await expect(page.getByRole('textbox', { name: 'Résumé text for this role' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await savedResume(page)).toBeNull();
});

test('a different résumé can be pasted and is sent only with the role save', async () => {
  const page = await open();
  await chooseResume(page, true);
  await page.getByRole('textbox', { name: 'Résumé text for this role' }).fill('  Payments lead, 42k requests per second.  ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await savedResume(page)).toBe('Payments lead, 42k requests per second.');
  expect(await page.evaluate(() => (window as any).__fake.calls.filter((p: string) => p.startsWith('profiles.') || p === 'documents.saveResume'))).toEqual([]);
});

test('a different résumé must have text; upload supplies it through the existing extractor', async () => {
  const page = await open();
  await chooseResume(page, true);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Upload or paste the résumé for this role, or choose Default résumé.')).toBeVisible();
  expect(await savedResume(page)).toBeUndefined();
  await page.evaluate(() => {
    (window as any).__fake.replies['dialog.openFile'] = { filePath: 'synthetic-resume.pdf' };
    (window as any).__fake.replies['documents.extractFile'] = { text: 'Uploaded role résumé.', filename: 'synthetic-resume.pdf' };
  });
  await page.getByRole('button', { name: 'Upload résumé' }).click();
  await expect(page.getByRole('textbox', { name: 'Résumé text for this role' })).toHaveValue('Uploaded role résumé.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await savedResume(page)).toBe('Uploaded role résumé.');
});

test('editing restores the role résumé; a late upload cannot replace a newer default choice', async () => {
  const page = await open();
  await page.evaluate((r) => (window as any).__harness.open(r), role);
  await expect(page.getByRole('textbox', { name: 'Résumé text for this role' })).toHaveValue(role.resumeText);
  await page.evaluate(() => {
    (window as any).__fake.replies['dialog.openFile'] = { filePath: 'synthetic-resume.pdf' };
    (window as any).__fake.replies['documents.extractFile'] = { defer: 'resume' };
  });
  await page.getByRole('button', { name: 'Upload résumé' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fake.deferredIds())).toContain('resume');
  await chooseResume(page, false);
  await page.evaluate(() => (window as any).__fake.settle('resume', { text: 'Stale upload.' }));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await savedResume(page)).toBeNull();
});
