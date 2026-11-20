import { test, expect } from './fixtures';

/**
 * M6, in the REAL app (main + SQLite + the actual pages) with NO key: a saved
 * conversation opens readable straight from the database — no report, no
 * model call — and "Keep" through the real IPC reports each half truthfully,
 * validating its destination in main. The sample data's conversations are
 * real persisted sessions with transcripts (written by sampleData, no model).
 */

test.use({ noApiKey: true });

/* eslint-disable @typescript-eslint/no-explicit-any */

test('history opens offline; Keep reports a failed summary as failed and keeps the transcript; a bad destination is refused in main', async ({ dashboard: page }) => {
  const seeded = await page.evaluate(async () => {
    const api = (window as any).api;
    const r = await api.data.loadSamples();
    await api.settings.set({ activeProfileId: r.profileId, onboardingDone: true });
    const pageOf = await api.session.page(r.profileId, '', 12, 0);
    return { profileId: r.profileId, total: pageOf.total, first: pageOf.items[0] };
  });
  expect(seeded.total).toBeGreaterThan(0);
  await page.reload();

  // ---- History: Sessions → Open, with no key ----
  await page.evaluate(() => (location.hash = '#/sessions'));
  await page.getByRole('button', { name: 'Open' }).first().click();
  const d = page.getByRole('dialog', { name: / · / });
  const conv = d.locator('section[aria-label="Conversation"]');
  await expect(conv.locator('li').first()).toBeVisible();
  await expect(conv).not.toContainText('Opening…');
  const firstTurn = await page.evaluate(async (id) => {
    const det = await (window as any).api.session.get(id);
    return det.transcript[0].text as string;
  }, seeded.first.id);
  await expect(conv).toContainText(firstTurn);
  await expect(d.getByRole('alert')).toHaveCount(0); // no "no API key" in place of the transcript
  // Nothing was generated to open it.
  expect(await page.evaluate((id) => (window as any).api.session.getReport(id), seeded.first.id)).toBeNull();
  await page.keyboard.press('Escape');

  // ---- Keep, through main: no key → the summary FAILED (said so), the
  // transcript is still there, memory suggestions are off (no consent). ----
  const kept = await page.evaluate(async (s) => {
    const api = (window as any).api;
    const r = await api.session.remember(s.id, s.jobId);
    const det = await api.session.get(s.id);
    return { r, turns: det.transcript.length };
  }, seeded.first);
  expect(kept.r.kept).toBe(true);
  expect(kept.r.summary.status).toBe('failed');
  expect(kept.r.summary.error).toBeTruthy();
  expect(kept.r.memory.status).toBe('off');
  expect(kept.turns).toBeGreaterThan(0);

  // ---- A destination that does not exist, or is another profile's, is
  // refused before anything is filed. ----
  const refused = await page.evaluate(async (s) => {
    const api = (window as any).api;
    const other = await api.profiles.create({ name: 'Other', targetRole: '', targetCompany: null, interviewType: 'general', language: 'en', resumeText: null, jdText: null });
    const theirs = await api.jobs.save({ profileId: other.id, kind: 'meeting', title: 'Theirs', company: null, jdUrl: null, jdText: null, companyUrl: null, notes: null });
    const out: string[] = [];
    for (const packId of ['no-such-space', theirs.job.id]) {
      try {
        await api.session.remember(s.id, packId);
        out.push('accepted');
      } catch (e) {
        out.push((e as Error).message);
      }
    }
    const det = await api.session.get(s.id);
    return { out, packId: det.jobId };
  }, seeded.first);
  expect(refused.out[0]).toMatch(/no longer exists/);
  expect(refused.out[1]).toMatch(/another profile/);
  expect(refused.packId).toBe(seeded.first.jobId); // never filed into either
});
