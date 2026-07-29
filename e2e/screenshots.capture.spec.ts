import { test, expect, choose, disablePrivacyMode, hasKey, setApiKey } from './fixtures';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * The still images — one per feature — used by the README, the landing page
 * (docs/index.html) and the docs.
 *
 *   E2E_CAPTURE=1 npx playwright test e2e/screenshots.capture.spec.ts
 *
 * See docs/21-MEDIA.md § Stills for what each image is for and where it is
 * referenced. Animated clips and the film come from media.capture.spec.ts.
 *
 * Every shot is optional: one moved button should cost one image, not the whole
 * set, and the run prints what it skipped so nothing goes missing quietly. The
 * suite still fails if too few images came out, because an almost-empty run
 * that exits green is worse than one that stops.
 *
 * Navigation goes through the sidebar's `data-tour` anchors rather than visible
 * link text: they are stable identifiers the onboarding tour already depends
 * on, so a copy change cannot silently break the capture — which is exactly how
 * the previous version of this file rotted, still clicking "Interview" / "Mock"
 * / "Reports" nav items the mode-first redesign had removed.
 *
 * CDP screenshots aren't blocked by Privacy Mode (that's an OS-capture
 * exclusion), but the windows are revealed anyway so what is shot is what a
 * user sees.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const OUT = resolve(process.cwd(), 'docs/images');
const IMG = (name: string) => resolve(OUT, name);

const taken: string[] = [];
const skipped: string[] = [];

/**
 * How long any single click/fill/wait may take before it is called a failure.
 *
 * Playwright's default action timeout is UNBOUNDED — bounded only by the test
 * timeout, which this run sets generously because it talks to a real API. So one
 * un-clickable element does not fail its shot; it eats the entire run.
 */
const ACTION_TIMEOUT = 15_000;

async function optional(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    taken.push(name);
  } catch (e) {
    skipped.push(`${name} — ${(e as Error).message.split('\n')[0]}`);
    console.warn(`  ! skipped ${name}: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    // Put the app back somewhere neutral. A shot that fails halfway can leave a
    // modal open, and a modal swallows every click behind it — so without this,
    // one skipped shot silently becomes every shot after it skipped too.
    for (let i = 0; i < 3; i++) {
      const open = await page
        .getByRole('dialog')
        .first()
        .isVisible()
        .catch(() => false);
      if (!open) break;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(350);
    }
  }
}

/** A fixed scroll of the page's own scroll container.
 *
 *  Not `scrollIntoViewIfNeeded`: the Approve row sits low but technically ON
 *  screen, so "if needed" decides nothing is needed and two shots that are
 *  supposed to differ come out identical. */
async function scrollBy(page: Page, px: number): Promise<void> {
  await page.evaluate((amount) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      (e) =>
        e.scrollHeight > e.clientHeight + 80 && /auto|scroll/.test(getComputedStyle(e).overflowY),
    );
    if (el) el.scrollTop = amount;
  }, px);
}

test('@capture marketing screenshots', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY to seed parsed sample data + a streamed answer');
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });

  dashboard.setDefaultTimeout(ACTION_TIMEOUT);
  await setApiKey(dashboard);
  await disablePrivacyMode(dashboard); // reveal windows so the shots aren't blank

  // Seed the demo world, with memory and archiving switched on the way a user
  // would — both are consent-gated OFF by default, which is correct and would
  // leave half these pages empty.
  const { profileId } = await dashboard.evaluate(async () => {
    const a = (window as any).api;
    await a.settings.set({ memoryEnabled: true, sessionArchiveEnabled: true });
    return a.data.loadSamples();
  });

  // Keep the two older standups, so the shots below have real continuity in
  // them: archives filed into a Space, and memory candidates waiting on a
  // decision. The most recent standup stays unkept — it is what a user who
  // presses "Load sample data" gets to try the loop on themselves.
  const kept = await dashboard.evaluate(async (pid) => {
    const a = (window as any).api;
    const sessions = await a.session.list(pid);
    const standups = sessions
      .filter((s: any) => /standup/i.test(s.jobTitle ?? ''))
      .sort((x: any, y: any) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
    const out: unknown[] = [];
    for (const s of standups.slice(0, 2)) out.push(await a.session.remember(s.id, s.jobId ?? null));
    return out;
  }, profileId);
  console.log(`screenshots: kept ${JSON.stringify(kept)}`);

  // Reload so the renderer's stores re-read what main now holds. Settings were
  // changed by IPC rather than through the settings store, so without this the
  // shots contradict each other — Home's status chip would still say
  // "Memory: off" beside a Memory page showing it on.
  await dashboard.reload();
  await dashboard.waitForTimeout(1800);

  const go = async (nav: string, settleMs = 700) => {
    await dashboard.locator(`[data-tour="nav-${nav}"]`).first().click();
    await dashboard.waitForTimeout(settleMs);
  };
  const hash = async (route: string, settleMs = 1000) => {
    await dashboard.evaluate((r) => {
      window.location.hash = r;
    }, route);
    await dashboard.waitForTimeout(settleMs);
  };

  // ── Home — greeting, primary actions, capture-status row, activity cards ───
  await optional(dashboard, 'home', async () => {
    await go('home');
    await expect(dashboard.getByRole('heading', { name: /how can .*help|hi /i })).toBeVisible();
    await dashboard.waitForTimeout(400);
    await dashboard.screenshot({ path: IMG('home.png') });
  });

  // ── Profile — the résumé and documents that ground everything ─────────────
  await optional(dashboard, 'profile', async () => {
    await hash(`#/profiles/${profileId}`, 1500);
    await dashboard.screenshot({ path: IMG('profile.png') });
  });

  // ── Library — Spaces, then the indexed documents behind them ──────────────
  await optional(dashboard, 'library', async () => {
    await go('library');
    await dashboard.screenshot({ path: IMG('library.png') });
  });

  await optional(dashboard, 'documents', async () => {
    await hash('#/library?tab=documents', 1200);
    await dashboard.screenshot({ path: IMG('documents.png') });
  });

  // ── New Space: the activity picker, then the tailoring offer ──────────────
  //    Two images from one modal, and therefore ONE block — a failed shot
  //    closes whatever it left open, so a second block would find it gone.
  //    The tailoring offer only exists once a job description is loaded, which
  //    is why this has to paste one rather than photograph an empty form.
  await optional(dashboard, 'new-space + tailored-resume', async () => {
    await hash('#/library?tab=spaces', 900);
    await dashboard.getByRole('button', { name: /new space/i }).first().click();
    const dialog = dashboard.getByRole('dialog');
    await dialog.waitFor();
    await dashboard.waitForTimeout(600);
    await dashboard.screenshot({ path: IMG('new-space.png') });

    await choose(dialog, /^Interview$/); // ACTIVITIES.job.label
    await dashboard.waitForTimeout(300);
    await dialog
      .locator('textarea')
      .first()
      .fill(
        'Northwind — Staff Engineer, Payments\n\n' +
          'You will own the design and delivery of the billing and entitlement services:\n' +
          'distributed systems at scale, Go and TypeScript, and the operational bar that\n' +
          'comes with money moving through them.\n\n' +
          'We look for engineers who have led a migration without an outage, who write\n' +
          'clearly, and who have opinions about on-call.',
      );
    await dashboard.waitForTimeout(900); // the offer animates in
    await dashboard.screenshot({ path: IMG('tailored-resume.png') });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ── Memory — the two switches, then the queue they govern ────────────────
  //    The feature hardest to explain in prose and easiest to show: a
  //    suggestion sitting there, un-remembered, until it is approved.
  await optional(dashboard, 'memory', async () => {
    await go('memory', 1100);
    await dashboard.screenshot({ path: IMG('memory.png') });
  });

  await optional(dashboard, 'memory-review', async () => {
    await scrollBy(dashboard, 330);
    await dashboard.waitForTimeout(400);
    await dashboard.screenshot({ path: IMG('memory-review.png') });
  });

  // ── Sessions — the history, filterable and scoped to this profile ─────────
  await optional(dashboard, 'sessions', async () => {
    await go('sessions');
    await dashboard.screenshot({ path: IMG('sessions.png') });
  });

  // ── The meeting report — what a kept conversation turns into ──────────────
  await optional(dashboard, 'meeting-report', async () => {
    await dashboard.evaluate(async (pid) => {
      const a = (window as any).api;
      const sessions = await a.session.list(pid);
      const s = sessions.find((x: any) => /standup/i.test(x.jobTitle ?? ''));
      if (s) await a.session.meetingReport(s.id); // warm it so the shot isn't a spinner
    }, profileId);
    await go('sessions');
    await dashboard
      .getByRole('row')
      .filter({ hasText: /standup/i })
      .first()
      .getByRole('button', { name: /^report$/i })
      .click();
    await dashboard.getByRole('dialog').waitFor({ timeout: 30_000 });
    await dashboard.waitForTimeout(1200);
    await dashboard.screenshot({ path: IMG('meeting-report.png') });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ── Insights — aggregate reporting ────────────────────────────────────────
  await optional(dashboard, 'insights', async () => {
    await go('reports');
    await dashboard.screenshot({ path: IMG('insights.png') });
  });

  // ── Settings — models, companion prefs, the key, privacy ──────────────────
  await optional(dashboard, 'settings', async () => {
    await go('settings');
    await expect(dashboard.getByRole('heading', { name: /openai models/i })).toBeVisible();
    await dashboard.waitForTimeout(400);
    await dashboard.screenshot({ path: IMG('settings.png') });
  });

  await optional(dashboard, 'privacy', async () => {
    await dashboard
      .locator('[data-tour="settings-privacy"]')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await dashboard.waitForTimeout(500);
    await dashboard.screenshot({ path: IMG('privacy.png') });
  });

  // ── Help — the reference a user actually lands on ─────────────────────────
  await optional(dashboard, 'help', async () => {
    await hash('#/help', 1000);
    await dashboard.screenshot({ path: IMG('help.png') });
  });

  // ── The start flow — the transparency panel, before anything is captured ──
  await optional(dashboard, 'start-flow', async () => {
    await go('home');
    await dashboard.getByRole('button', { name: /start listening/i }).first().click();
    await expect(dashboard.getByRole('dialog')).toBeVisible();
    await dashboard.waitForTimeout(600);
    await dashboard.screenshot({ path: IMG('start-flow.png') });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ── Cue Card (hero) — a real grounded answer, driven through the same
  //    contribution pipeline a heard question uses ───────────────────────────
  const overlay = dashboard
    .context()
    .pages()
    .find((p) => p.url().includes('view=overlay'));

  await optional(dashboard, 'cue-card', async () => {
    if (!overlay) throw new Error('overlay window not found');
    const spaces: { id: string; title: string }[] = await dashboard.evaluate(
      async (pid) => (window as any).api.jobs.list(pid),
      profileId,
    );
    const googleId = spaces.find((s) => /L4/.test(s.title))?.id ?? null;
    await dashboard.evaluate(async () => {
      await (window as any).api.overlay.setMode('expanded');
    });
    const sessionId = await dashboard.evaluate(
      async ([pid, jid]) => {
        const s = await (window as any).api.session.start(
          pid,
          'behavioral',
          jid,
          'key_points',
          'job',
        );
        return s.id as string;
      },
      [profileId, googleId] as const,
    );
    // `session.ask` resolves only once the answer is fully generated — which is
    // exactly what a still wants, so unlike the film's clips this one DOES await
    // it. A fixed sleep here is the wrong tool twice over: too short and the
    // shot is a half-written answer, too long and it is a minute of nothing.
    await dashboard.evaluate(
      async ([sid]) =>
        (window as any).api.session.ask(
          sid,
          'Tell me about a time you improved the performance of a system that was already in production.',
        ),
      [sessionId] as const,
    );
    await overlay.waitForTimeout(1200); // let the final tokens paint
    await overlay.screenshot({ path: IMG('cue-card.png') });

    // …and the same session stopped, which is what raises the save prompt.
    await dashboard.evaluate(
      async ([sid]) => (window as any).api.session.stop(sid),
      [sessionId] as const,
    );
    await dashboard.waitForTimeout(2000);
    await dashboard.getByRole('dialog').waitFor({ timeout: 10_000 });
    await dashboard.screenshot({ path: IMG('save-prompt.png') });
    await dashboard.keyboard.press('Escape');
  });

  console.log(`\n  ${taken.length} image(s): ${taken.join(', ')}`);
  if (skipped.length) console.log(`  skipped:\n${skipped.map((s) => `    - ${s}`).join('\n')}`);
  if (taken.length < 10) {
    throw new Error(`only ${taken.length} image(s) captured — the doc set would be full of holes`);
  }
});
