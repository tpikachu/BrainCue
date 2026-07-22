import { test, expect, hasKey, setApiKey } from './fixtures';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// Opt-in capture utility — regenerates the STILL images used by the README and
// the landing page (docs/index.html):
//
//   E2E_CAPTURE=1 npx playwright test e2e/screenshots.capture.spec.ts
//
// See e2e/README.md § Capturing marketing media. Animated clips come from
// media.capture.spec.ts instead.
//
// Navigation goes through the sidebar's `data-tour` anchors rather than link
// text: they are stable identifiers the tour already depends on, so a copy
// change doesn't silently break the capture (which is how the previous version
// of this file rotted — it still clicked "Interview"/"Mock"/"Reports" nav items
// that the mode-first redesign removed).
//
// CDP screenshots aren't blocked by Privacy Mode (that's an OS-capture
// exclusion), but we reveal the windows anyway so what we shoot is what a user
// sees.
/* eslint-disable @typescript-eslint/no-explicit-any */
const OUT = resolve(process.cwd(), 'docs/images');
const IMG = (name: string) => resolve(OUT, name);

test('@capture marketing screenshots', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY to seed parsed sample data + a streamed answer');
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });

  await setApiKey(dashboard);
  await dashboard.evaluate(async () => {
    await (window as any).api.privacy.set(false); // reveal windows for the capture
  });

  // Seed a populated app: sample profile + parsed Spaces (JD + company research).
  const { profileId } = await dashboard.evaluate(async () =>
    (window as any).api.data.loadSamples(),
  );

  const go = async (nav: string) => {
    await dashboard.locator(`[data-tour="nav-${nav}"]`).first().click();
    await dashboard.waitForTimeout(600);
  };

  // ── Home — the launcher: primary actions, capture-status row, mode cards
  //    (shipped, Labs, and the "coming soon" strip) ───────────────────────────
  await go('home');
  await expect(dashboard.getByRole('heading', { name: /how can braincue help/i })).toBeVisible();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('home.png') });

  // ── Library — profile, Spaces, documents, memory ──────────────────────────
  await go('library');
  await dashboard.waitForTimeout(600);
  await dashboard.screenshot({ path: IMG('library.png') });

  // ── Sessions — history across every mode ──────────────────────────────────
  await go('sessions');
  await dashboard.waitForTimeout(600);
  await dashboard.screenshot({ path: IMG('sessions.png') });

  // ── Insights — aggregate reporting ────────────────────────────────────────
  await go('reports');
  await dashboard.waitForTimeout(600);
  await dashboard.screenshot({ path: IMG('insights.png') });

  // ── Settings — models, companion prefs, privacy ───────────────────────────
  await go('settings');
  await expect(dashboard.getByRole('heading', { name: /openai models/i })).toBeVisible();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('settings.png') });

  // ── The start flow — the transparency panel before anything is captured ───
  await go('home');
  await dashboard.getByRole('button', { name: /start listening/i }).first().click();
  await expect(dashboard.getByRole('dialog')).toBeVisible();
  await dashboard.waitForTimeout(500);
  await dashboard.screenshot({ path: IMG('start-flow.png') });
  await dashboard.keyboard.press('Escape');

  // ── Cue Card (hero) — run a mock so a grounded answer streams in ──────────
  try {
    await dashboard.evaluate(async () => {
      await (window as any).api.overlay.setMode('expanded');
    });
    await dashboard.evaluate(
      async (pid) => (window as any).api.mock.start(pid, 'alloy', null, 'behavioral'),
      profileId,
    );
    const overlay = dashboard
      .context()
      .pages()
      .find((p) => p.url().includes('view=overlay'));
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
