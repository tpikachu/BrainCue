import { test, expect, hasKey, setApiKey } from './fixtures';
import { resolve } from 'node:path';

// Opt-in capture utility (run: E2E_CAPTURE=1 npx playwright test e2e/screenshots.capture.spec.ts).
// Drives the real app to produce README screenshots. CDP screenshots aren't blocked
// by Privacy Mode (that's an OS-capture exclusion), but we reveal anyway for clarity.
/* eslint-disable @typescript-eslint/no-explicit-any */
const IMG = (name: string) => resolve(process.cwd(), 'docs/images', name);

test('@capture generate README screenshots', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY to populate sample data + a mock answer');
  test.setTimeout(240_000);

  await setApiKey(dashboard);
  await dashboard.evaluate(async () => {
    await (window as any).api.privacy.set(false); // reveal windows for the capture
  });

  // Seed a populated app: sample profile + Google/Amazon/Stripe interviews (parsed).
  const { profileId } = await dashboard.evaluate(async () => (window as any).api.data.loadSamples());

  const selectProfile = async () => {
    const sel = dashboard.locator('select').first();
    await sel.waitFor();
    await sel.selectOption({ index: 1 }); // 0 = "Select a profile…"
  };

  // ── Interview ──────────────────────────────────────────────────────────────
  await dashboard.getByRole('link', { name: /interview/i }).first().click();
  await selectProfile();
  await expect(dashboard.getByText(/Google|Amazon|Stripe/).first()).toBeVisible();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('interview.png') });

  // ── Settings (preset + Custom indicator) ─────────────────────────────────────
  await dashboard.evaluate(async () => {
    await (window as any).api.settings.set({ modelPreset: 'best', models: { answer: 'gpt-4o' } });
  });
  await dashboard.getByRole('link', { name: /settings/i }).first().click();
  await expect(dashboard.getByRole('heading', { name: 'OpenAI Models' })).toBeVisible();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('settings.png') });
  await dashboard.evaluate(async () => {
    await (window as any).api.settings.set({ modelPreset: 'balanced', models: {} });
  });

  // ── Mock ─────────────────────────────────────────────────────────────────────
  await dashboard.getByRole('link', { name: /mock/i }).first().click();
  await selectProfile();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('mock.png') });

  // ── Reports ───────────────────────────────────────────────────────────────────
  await dashboard.getByRole('link', { name: /reports/i }).first().click();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('reports.png') });

  // ── Cue Card (hero) — start a mock so a grounded answer streams in ─────────────
  try {
    await dashboard.evaluate(async () => {
      await (window as any).api.overlay.setMode('expanded');
    });
    await dashboard.evaluate(
      async (pid) => (window as any).api.mock.start(pid, 'alloy', null, 'behavioral'),
      profileId,
    );
    const overlay = dashboard.context().pages().find((p) => p.url().includes('view=overlay'));
    if (overlay) {
      await overlay.waitForTimeout(14_000); // let the question + answer stream in
      await overlay.screenshot({ path: IMG('cue-card.png') });
    }
    await dashboard.evaluate(async () => {
      const api = (window as any).api;
      const r = await api.session.list();
      if (r[0]) await api.mock.end(r[0].id);
    });
  } catch {
    /* hero is best-effort; the page screenshots above are the priority */
  }
});
