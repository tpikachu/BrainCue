import { test, expect, disablePrivacyMode, hasKey, setApiKey } from './fixtures';
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
  await disablePrivacyMode(dashboard); // reveal windows so the shots aren't blank

  // Seed a populated app: sample profile, parsed Spaces, and one finished
  // conversation in the sample standup Space.
  const { profileId } = await dashboard.evaluate(async () =>
    (window as any).api.data.loadSamples(),
  );

  // Keep that conversation, so the shots below have real continuity in them:
  // an archive filed into its Space and memory candidates waiting for review.
  // Memory is consent-gated OFF, which is the correct default and would leave
  // the Memory page empty — so this turns it on exactly as a user would.
  const kept = await dashboard.evaluate(async (pid) => {
    const api = (window as any).api;
    await api.settings.set({ memoryEnabled: true, sessionArchiveEnabled: true });
    const sessions = await api.session.list(pid);
    const sample = sessions.find(
      (s: any) => s.jobTitle?.includes('standup') || s.jobCompany?.includes('Atlas'),
    );
    if (!sample) return null;
    return api.session.remember(sample.id, sample.jobId ?? null);
  }, profileId);
  console.log(`screenshots: kept the sample conversation → ${JSON.stringify(kept)}`);

  // Reload so the renderer's stores re-read what main now holds. Settings were
  // changed by IPC rather than through the settings store, so without this the
  // shots contradict each other — Home's status chip would still say
  // "Memory: off" beside a Memory page showing it on.
  await dashboard.reload();
  await dashboard.waitForTimeout(1500);

  const go = async (nav: string) => {
    await dashboard.locator(`[data-tour="nav-${nav}"]`).first().click();
    await dashboard.waitForTimeout(600);
  };

  // ── Home — the launcher: greeting, primary actions, capture-status row, and
  //    the activity cards (shipped, Labs, and the "coming soon" strip) ────────
  await go('home');
  await expect(dashboard.getByRole('heading', { name: /how can .*help|hi /i })).toBeVisible();
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('home.png') });

  // ── Library — the active profile's Spaces and documents ───────────────────
  await go('library');
  await dashboard.waitForTimeout(600);
  await dashboard.screenshot({ path: IMG('library.png') });

  // ── Memory — the review queue and the two switches ────────────────────────
  //    The feature that is hardest to explain in prose and easiest to show: a
  //    suggestion sitting there, un-remembered, until it is approved.
  await go('memory');
  await dashboard.waitForTimeout(900);
  await dashboard.screenshot({ path: IMG('memory.png') });
  // …and a second shot scrolled to the review queue, where the Approve/Reject
  // decision is actually visible. The top of the page explains the two
  // switches; this one shows the thing they govern.
  // A fixed scroll, not scrollIntoViewIfNeeded: the Approve row sits low but
  // technically ON screen, so "if needed" decides nothing is needed and the
  // shot comes out identical to the one above it.
  await dashboard.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      (e) =>
        e.scrollHeight > e.clientHeight + 80 && /auto|scroll/.test(getComputedStyle(e).overflowY),
    );
    if (el) el.scrollTop = 330;
  });
  await dashboard.waitForTimeout(400);
  await dashboard.screenshot({ path: IMG('memory-review.png') });

  // ── Sessions — the history, filterable and scoped to this profile ─────────
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
