import { test, choose, disablePrivacyMode, hasKey, setApiKey } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

/**
 * The marketing film, captured from the real app.
 *
 *   E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts
 *   node scripts/build-media.mjs --manifest docs/media/frames/demo/manifest.json --out braincue-demo
 *
 * See docs/21-MEDIA.md for the storyboard in prose, the style rules, and what
 * every asset is for. This file is the executable half of that document.
 *
 * Three things about how it is built.
 *
 * **A scene registers itself as it is captured.** The previous version kept the
 * shots and the manifest in two places and filtered one against the other, so a
 * scene could be captured and never assembled, or listed and never shot. Here
 * `shot()` and `clip()` push their own manifest entry, and `card()` pushes one
 * for a scene that has no frames at all. The manifest cannot disagree with what
 * is on disk because it is written from what went to disk.
 *
 * **Every shot is optional.** This run drives a real app against a real API for
 * several minutes; one moved button should shorten the film, not destroy the
 * take. `optional()` catches, logs, and carries on, and the end of the run
 * prints exactly what was skipped so nothing goes missing quietly.
 *
 * **Callout rectangles are measured, never typed.** A highlight box comes from
 * `boundingBox()` on the real element, scaled to the canvas — so it cannot end
 * up pointing at whitespace after a layout change, which a hand-typed
 * coordinate silently would.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const FRAMES = resolve(process.cwd(), 'docs/media/frames');
const DEMO = resolve(FRAMES, 'demo');

/** The canvas the film is assembled on. The app window is driven at this size,
 *  so measured callout rectangles map 1:1 onto the frame. */
const CANVAS = { width: 1280, height: 800 };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

interface ShotSpec {
  /** Frame directory under docs/media/frames/demo — also the scene's identity. */
  dir: string;
  /** The eyebrow above the caption: which part of the product this is. */
  kicker?: string;
  /** The sentence the viewer reads. */
  caption: string;
  /** Seconds on screen. */
  hold?: number;
  transition?: string;
  transitionSec?: number;
  /** Highlight one element, measured at capture time. */
  spotlight?: { of: Locator; label?: string };
}

interface ClipSpec extends Omit<ShotSpec, 'hold' | 'spotlight'> {
  /** Playback rate for the captured frames. */
  fps?: number;
  /** Freeze the last frame this long, so a stream's payoff stays readable. */
  tailHold?: number;
}

const scenes: Record<string, unknown>[] = [];
const skipped: string[] = [];

/**
 * How long any single click/fill/wait may take before it is called a failure.
 *
 * Playwright's default action timeout is UNBOUNDED — bounded only by the test
 * timeout, which this run deliberately sets to ~25 minutes. So one un-clickable
 * element does not fail its scene; it eats the entire capture. That is not
 * hypothetical: a modal left open by a failed scene intercepts every pointer
 * event behind it, so the next `nav()` waits for actionability that will never
 * come, and the run dies on scene six having produced five frames.
 */
const ACTION_TIMEOUT = 15_000;

/** A generated card — no frames, so it can never be blocked by the app. */
function card(spec: Record<string, unknown>): void {
  scenes.push({ transition: 'fade', transitionSec: 0.7, ...spec });
}

/**
 * Run one scene. A failure costs that scene and nothing else.
 *
 * Anything that talks to OpenAI can legitimately come back empty (a model that
 * proposes no memories, a Space with no conflict), and anything that clicks can
 * legitimately miss. Neither is worth losing a ten-minute capture over.
 */
async function optional(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    skipped.push(`${name} — ${(e as Error).message.split('\n')[0]}`);
    console.warn(`  ! skipped ${name}: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    // Put the app back somewhere neutral. A scene that fails halfway can leave
    // a modal open, and a modal swallows every click behind it — so without
    // this, one skipped scene silently becomes every scene after it skipped
    // too, each waiting out its own timeout.
    await dismissDialogs(page);
  }
}

/** Close anything modal, without assuming a particular modal is open. */
async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const open = await page
      .getByRole('dialog')
      .first()
      .isVisible()
      .catch(() => false);
    if (!open) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350);
  }
}

/** The element's rectangle in canvas coordinates, or null if it isn't there. */
async function measure(page: Page, of: Locator, label?: string): Promise<Rect | null> {
  try {
    const box = await of.first().boundingBox({ timeout: 4000 });
    if (!box) return null;
    const vw = await page.evaluate(() => window.innerWidth);
    const k = CANVAS.width / vw; // HiDPI or a resized window must not shift the box
    const pad = 6;
    return {
      x: Math.max(0, (box.x - pad) * k),
      y: Math.max(0, (box.y - pad) * k),
      w: (box.width + pad * 2) * k,
      h: (box.height + pad * 2) * k,
      label,
    };
  } catch {
    return null;
  }
}

/** A held frame. The Ken Burns push is applied at assembly, not here. */
async function shot(page: Page, spec: ShotSpec): Promise<void> {
  const dir = resolve(DEMO, spec.dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const callout = spec.spotlight
    ? await measure(page, spec.spotlight.of, spec.spotlight.label)
    : null;
  await page.screenshot({ path: resolve(dir, 'frame-0000.png') });
  scenes.push({
    type: 'still',
    dir: spec.dir,
    durationSec: spec.hold ?? 3.8,
    kicker: spec.kicker,
    caption: spec.caption,
    transition: spec.transition ?? 'fade',
    transitionSec: spec.transitionSec ?? 0.5,
    ...(callout ? { callout } : {}),
  });
}

/**
 * Capture the interesting part of a stream and nothing else.
 *
 * A fixed-length burst is the wrong tool: most of the wall-clock time is spent
 * waiting for speech and transcription, and the answer itself streams in a
 * couple of seconds — so a fixed window yields a long tail of byte-identical
 * frames and the clip reads as a still image. Instead: idle until the page's
 * text actually starts growing, then sample densely until it stops.
 */
async function captureStream(
  page: Page,
  dir: string,
  opts: {
    intervalMs: number;
    settleMs: number;
    maxFrames: number;
    startTimeoutMs: number;
    /** Characters that must accumulate before "text stopped changing" is
     *  allowed to mean "finished". Without this the capture ends during the
     *  quiet gap between the question landing and the first answer token —
     *  which is how the clip once came out as 11 near-identical frames. */
    minGrowth: number;
  },
): Promise<number> {
  const abs = resolve(DEMO, dir);
  rmSync(abs, { recursive: true, force: true }); // never mix frames across runs
  mkdirSync(abs, { recursive: true });

  // Digits are stripped before measuring. The Cue Card runs a session clock, so
  // raw `innerText` changes every second forever — "the text stopped growing"
  // is then never true, every clip runs to `maxFrames`, and a five-second answer
  // costs thirty seconds of capture whose extra frames are thrown away as
  // duplicates at assembly. Nothing being measured for here is a number.
  const textLen = () =>
    page.evaluate(() =>
      document.body.innerText.replace(/[\d:]/g, '').replace(/\s+/g, ' ').trim().length,
    );

  const baseline = await textLen();
  const startBy = Date.now() + opts.startTimeoutMs;
  while (Date.now() < startBy) {
    if ((await textLen()) > baseline + 40) break;
    await page.waitForTimeout(200);
  }

  // Growth is measured from the BASELINE, not from where growth was detected.
  // Re-reading here looks tidier and is wrong: if the stream lands faster than
  // this loop polls, the re-read already contains the whole answer, `peak-from`
  // is ~0, `minGrowth` is never reached, and the capture runs to `maxFrames`
  // filming a screen that stopped changing seconds ago.
  const from = baseline;
  let frames = 0;
  let lastLen = -1;
  let stableMs = 0;
  let peak = from;
  while (frames < opts.maxFrames) {
    await page.screenshot({ path: resolve(abs, `frame-${String(frames).padStart(4, '0')}.png`) });
    frames++;
    await page.waitForTimeout(opts.intervalMs);
    const len = await textLen();
    peak = Math.max(peak, len);
    stableMs = len === lastLen ? stableMs + opts.intervalMs : 0;
    lastLen = len;
    if (peak - from >= opts.minGrowth && stableMs >= opts.settleMs) break;
  }
  return frames;
}

/** A streamed scene: the real frame sequence, at the rate it happened. */
async function clip(
  page: Page,
  spec: ClipSpec,
  stream: Parameters<typeof captureStream>[2],
): Promise<void> {
  const frames = await captureStream(page, spec.dir, stream);
  if (frames < 3) throw new Error(`only ${frames} frame(s) — nothing streamed`);
  console.log(`  ${spec.dir}: ${frames} frames`);
  scenes.push({
    type: 'motion',
    dir: spec.dir,
    fps: spec.fps ?? 10,
    tailHoldSec: spec.tailHold ?? 2.5,
    kicker: spec.kicker,
    caption: spec.caption,
    transition: spec.transition ?? 'fade',
    transitionSec: spec.transitionSec ?? 0.5,
  });
}

/**
 * Scroll the page's own scroll container by a fixed amount.
 *
 * Two things this is NOT: `scrollIntoViewIfNeeded`, which does nothing when the
 * target is technically already on screen — the Approve row sat at y=743 of an
 * 800px viewport, in view and squarely under the caption; and a text locator,
 * which once waited out an entire test timeout on a table that had just
 * remounted. This cannot hang and cannot decide the scroll is unnecessary.
 */
async function scrollBy(page: Page, px: number): Promise<void> {
  await page.evaluate((amount) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      (e) =>
        e.scrollHeight > e.clientHeight + 80 && /auto|scroll/.test(getComputedStyle(e).overflowY),
    );
    if (el) el.scrollTop = amount;
  }, px);
}

test('@capture the demo film', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY — the answers in this film are real');
  test.setTimeout(1_500_000); // ~25 min: a long drive against a live API

  dashboard.setDefaultTimeout(ACTION_TIMEOUT);
  await setApiKey(dashboard);
  await disablePrivacyMode(dashboard);

  rmSync(DEMO, { recursive: true, force: true });
  mkdirSync(DEMO, { recursive: true });

  // HashRouter: navigation is just the hash.
  const go = async (route: string, settleMs = 900): Promise<void> => {
    await dashboard.evaluate((r) => {
      window.location.hash = r;
    }, route);
    await dashboard.waitForTimeout(settleMs);
  };
  const nav = async (name: string): Promise<void> => {
    await dashboard.locator(`[data-tour="nav-${name}"]`).first().click();
    await dashboard.waitForTimeout(700);
  };
  const api = <T,>(fn: (a: any) => Promise<T> | T): Promise<T> =>
    dashboard.evaluate(fn as any, undefined as any) as Promise<T>;

  // Memory and archiving are consent-gated OFF, which is the correct default
  // and would make half this film empty. Turn them on the way a user would,
  // then reload so the renderer's stores agree with what main now holds —
  // without it Home's status chip contradicts the Memory page in the same cut.
  const { profileId } = await dashboard.evaluate(async () => {
    const a = (window as any).api;
    await a.settings.set({ memoryEnabled: true, sessionArchiveEnabled: true });
    return a.data.loadSamples();
  });
  await dashboard.reload();
  await dashboard.waitForTimeout(2000);

  const spaces: { id: string; title: string; kind: string }[] = await dashboard.evaluate(
    async (pid) => (window as any).api.jobs.list(pid),
    profileId,
  );
  const spaceId = (match: RegExp): string | null =>
    spaces.find((s) => match.test(s.title))?.id ?? null;
  const googleId = spaceId(/L4/);
  const standupId = spaceId(/standup/i);

  // ══ Act 0 · Why ════════════════════════════════════════════════════════════
  // Three cards, no app. The film has to earn the next two minutes before it
  // shows a single screenshot, and the argument is short enough to read.
  card({
    type: 'title',
    logo: true,
    durationSec: 4.8,
    eyebrow: 'BrainCue',
    title: 'You are in the call.\nYour notes are not.',
    subtitle: 'A local-first AI companion for live conversations',
  });
  card({
    type: 'chapter',
    durationSec: 4.0,
    title: 'The context that would help\nis in a document you cannot open right now.',
  });
  card({
    type: 'chapter',
    durationSec: 4.0,
    title: 'And when the call ends,\neverything it taught you is gone.',
  });

  // ══ Act 1 · What it knows ══════════════════════════════════════════════════
  card({ type: 'chapter', durationSec: 2.6, eyebrow: 'One', title: 'What it knows' });

  await optional(dashboard, 'home', async () => {
    await nav('home');
    await dashboard.getByRole('heading', { name: /how can .*help|^hi /i }).first().waitFor();
    await shot(dashboard, {
      dir: '01-home',
      kicker: 'Home',
      caption: 'Everything starts with one question: what is this call?',
      hold: 4.2,
    });
  });

  await optional(dashboard, 'profile', async () => {
    await go(`#/profiles/${profileId}`, 1400);
    await shot(dashboard, {
      dir: '02-profile',
      kicker: 'Your material',
      caption: 'Your résumé and documents go in once. They stay on this machine.',
    });
  });

  await optional(dashboard, 'spaces', async () => {
    await go('#/library?tab=spaces', 1200);
    await shot(dashboard, {
      dir: '03-spaces',
      kicker: 'Library · Spaces',
      caption: 'A Space is one recurring context — a standup, a role, a house move.',
      hold: 4.2,
    });
  });

  await optional(dashboard, 'documents', async () => {
    await go('#/library?tab=documents', 1200);
    await shot(dashboard, {
      dir: '04-documents',
      kicker: 'Library · Documents',
      caption: 'Everything is indexed locally. Nothing is uploaded anywhere.',
    });
  });

  // Two scenes from one modal, and therefore ONE optional block: a failed scene
  // closes whatever it left open, so a second block would find the modal gone.
  //
  // The activity picker earns a scene of its own precisely because there is no
  // mode picker beside it. The tailoring offer that follows arrives WITH the job
  // description, so the scene has to paste one — a shot of the empty modal would
  // show nothing at all.
  await optional(dashboard, 'new Space — activity, then tailoring', async () => {
    await go('#/library?tab=spaces', 900);
    await dashboard.getByRole('button', { name: /new space/i }).first().click();
    const dialog = dashboard.getByRole('dialog');
    await dialog.waitFor();
    await dashboard.waitForTimeout(600);
    await shot(dashboard, {
      dir: '05-activity',
      kicker: 'New Space',
      caption: 'You say what the conversation IS. Never which mode to run.',
      hold: 4.4,
      spotlight: {
        of: dialog.locator('button[aria-haspopup="listbox"]').first(),
        label: 'eight activities',
      },
    });

    await choose(dialog, /^Interview$/); // ACTIVITIES.job.label
    await dashboard.waitForTimeout(300);
    await dialog.locator('textarea').first().fill(
      'Northwind — Staff Engineer, Payments\n\n' +
        'You will own the design and delivery of the billing and entitlement\n' +
        'services: distributed systems at scale, Go and TypeScript, and the\n' +
        'operational bar that comes with money moving through them.\n\n' +
        'We look for engineers who have led a migration without an outage, who\n' +
        'write clearly, and who have opinions about on-call.',
    );
    await dashboard.waitForTimeout(900); // the offer animates in
    await shot(dashboard, {
      dir: '06-tailor',
      kicker: 'Interview Space',
      caption: 'Paste a job description, and it offers to tailor your résumé to that role.',
      hold: 4.6,
      spotlight: {
        of: dialog.locator('.rise-enter').first(),
        label: 'kept with this Space only',
      },
    });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ══ Act 2 · In the room ════════════════════════════════════════════════════
  card({ type: 'chapter', durationSec: 2.6, eyebrow: 'Two', title: 'In the room' });

  await optional(dashboard, 'start flow', async () => {
    await nav('home');
    await dashboard.getByRole('button', { name: /start listening/i }).first().click();
    const dialog = dashboard.getByRole('dialog');
    await dialog.waitFor();
    await dashboard.waitForTimeout(700);
    await shot(dashboard, {
      dir: '07-start',
      kicker: 'Before anything is captured',
      caption: 'It tells you exactly what will be recorded, and exactly what will be sent.',
      hold: 5.0,
      spotlight: {
        of: dialog.getByText(/captured on this machine/i),
        label: 'no surprises',
      },
    });
    await shot(dashboard, {
      dir: '08-space-choice',
      caption: 'And what will survive the call. No Space, and nothing is kept.',
      hold: 4.2,
      spotlight: {
        of: dialog.getByText(/without one, nothing is summarised/i),
        label: 'said before you start, not after',
      },
    });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ── The live moment ────────────────────────────────────────────────────────
  await dashboard.evaluate(async () => {
    await (window as any).api.overlay.setMode('expanded');
  });
  const overlay = dashboard
    .context()
    .pages()
    .find((p) => p.url().includes('view=overlay'));
  if (!overlay) throw new Error('overlay window not found — is the Cue Card open?');
  overlay.setDefaultTimeout(ACTION_TIMEOUT);

  // The hero shot runs a MOCK: an AI interviewer asks out loud and the app
  // transcribes what it hears. Everything after it is driven by injecting the
  // question directly, which is deterministic — but only real audio can honestly
  // carry the caption "it transcribes the room", so the transcription scene is
  // the one that pays for the flakiness.
  await optional(dashboard, 'live transcription + first answer', async () => {
    const running = dashboard
      .evaluate(
        async ([pid, jid]) => (window as any).api.mock.start(pid, 'alloy', jid, 'behavioral'),
        [profileId, googleId] as const,
      )
      .catch(() => {
        /* torn down below; a late rejection must not fail the capture */
      });
    await clip(
      overlay,
      {
        dir: '09-cuecard',
        kicker: 'The Cue Card',
        caption:
          'It hears the question, transcribes it live, and streams a grounded answer into an overlay.',
        fps: 10,
        tailHold: 3.2,
      },
      {
        intervalMs: 100, // the answer streams in ~1s — sample fine or it's a jump cut
        settleMs: 700,
        minGrowth: 250, // an answer's worth of text must land before this is "done"
        maxFrames: 300,
        startTimeoutMs: 90_000, // spoken question + transcription can be slow
      },
    );
    await running;
    await dashboard.evaluate(async () => {
      const a = (window as any).api;
      const r = await a.session.list();
      if (r[0]) await a.mock.end(r[0].id);
    });
    await dashboard.waitForTimeout(1200);
  });

  // A real interview session in the Google Space, driven by injected questions.
  // `session.ask` goes through the same contribution pipeline a heard question
  // does (ipc/contributionBridge.ts) — same retrieval, same streaming, same
  // card — so what these scenes show is the product, not a demo mode.
  let liveId: string | null = null;
  await optional(dashboard, 'grounded, cited answer', async () => {
    liveId = await dashboard.evaluate(
      async ([pid, jid]) => {
        const s = await (window as any).api.session.start(pid, 'behavioral', jid, 'key_points', 'job');
        return s.id as string;
      },
      [profileId, googleId] as const,
    );
    // NOT awaited. `session.ask` resolves only once the answer has been fully
    // generated (session.ipc.ts returns the promise from `answerQuestion`, its
    // "fire-and-forget" comment notwithstanding) — so awaiting it means the
    // capture starts after the streaming is over, and every frame is identical.
    // This is the same trap as `mock.start`, in a call that does not look like
    // it: 260 frames, 1 unique image.
    const asking = dashboard
      .evaluate(
        async ([sid]) =>
          (window as any).api.session.ask(
            sid,
            'Tell me about a time you improved the performance of a system that was already in production.',
          ),
        [liveId] as const,
      )
      .catch(() => {});
    await clip(
      overlay,
      {
        dir: '10-grounded',
        kicker: 'Grounded',
        caption: 'The answer is built from YOUR material — not from what the model assumes about you.',
        fps: 10,
        tailHold: 3.4,
      },
      { intervalMs: 110, settleMs: 800, minGrowth: 220, maxFrames: 260, startTimeoutMs: 60_000 },
    );
    await asking;
  });

  await optional(dashboard, 'citations', async () => {
    await overlay.waitForTimeout(900);
    await shot(overlay, {
      dir: '11-citations',
      kicker: 'Provenance',
      caption: 'Every card says where it came from, so you can check it in the two seconds you have.',
      hold: 4.4,
    });
  });

  // STAR is an answer FORMAT, not a story bank: the same answer, re-told.
  await optional(dashboard, 'STAR format', async () => {
    if (!liveId) throw new Error('no live session');
    await dashboard.evaluate(async () => {
      await (window as any).api.session.setAnswerPrefs({ format: 'star' });
    });
    // Same rule as the ask above: `regenerate` resolves when the re-told answer
    // has finished streaming, so it is started and filmed, not awaited.
    const regenerating = dashboard
      .evaluate(async () => (window as any).api.session.regenerate())
      .catch(() => {});
    await clip(
      overlay,
      {
        dir: '12-star',
        kicker: 'Answer formats',
        caption: 'Re-tell the same answer as key points, a short explanation, or a STAR story.',
        fps: 10,
        tailHold: 3.4,
      },
      { intervalMs: 110, settleMs: 800, minGrowth: 200, maxFrames: 260, startTimeoutMs: 60_000 },
    );
    await regenerating;
  });

  await optional(dashboard, 'coding help', async () => {
    await dashboard.evaluate(async () => {
      await (window as any).api.session.setAnswerPrefs({ format: 'key_points' });
      await (window as any).api.capture.solve(
        'Given an array of integers nums and an integer target, return the indices of the two ' +
          'numbers that add up to target. You may assume exactly one solution exists.',
      );
    });
    await clip(
      overlay,
      {
        dir: '13-coding',
        kicker: 'Capture a region',
        caption: 'Grab any part of your screen and it solves what is in it — with the complexity.',
        fps: 10,
        tailHold: 3.4,
      },
      { intervalMs: 110, settleMs: 900, minGrowth: 200, maxFrames: 280, startTimeoutMs: 60_000 },
    );
  });

  // ── Stealth ────────────────────────────────────────────────────────────────
  // Its own chapter, because for an interview it is the whole proposition: help
  // that is worthless if the other side can see it. It used to be one settings
  // screenshot near the end, which is how a headline feature reads as a toggle.
  card({
    type: 'chapter',
    durationSec: 3.4,
    eyebrow: 'And they cannot see any of it',
    title: 'Invisible in the share.',
  });

  await optional(dashboard, 'the card they cannot see', async () => {
    await shot(overlay, {
      dir: '14-stealth',
      kicker: 'On your screen',
      caption: 'This is on your screen while you are sharing it.',
      hold: 3.8,
    });
  });

  // The explainer loop — drawn, not recorded, and deliberately unlike a
  // screenshot. Proving invisibility needs the frame the other side sees, and
  // an OS-level capture of that frame contains whatever is actually behind the
  // window, i.e. the operator's real desktop. `scripts/verify-privacy-capture.mjs`
  // produces that proof for anyone who wants to check it; it must never be
  // published. This says the same true thing without shipping someone's screen.
  scenes.push({
    type: 'asset',
    src: 'stealth-split.gif',
    durationSec: 8,
    transition: 'fade',
    transitionSec: 0.5,
  });

  await optional(dashboard, 'privacy mode', async () => {
    await go('#/settings', 1100);
    const privacy = dashboard.locator('[data-tour="settings-privacy"]');
    await privacy.first().scrollIntoViewIfNeeded().catch(() => {});
    await dashboard.waitForTimeout(500);
    await shot(dashboard, {
      dir: '15-privacy',
      kicker: 'Privacy Mode',
      caption: 'Every window is excluded from screen capture at the OS level. On by default.',
      hold: 4.8,
      spotlight: { of: privacy, label: 'not a setting you have to remember' },
    });
  });

  // ══ Act 3 · What survives the call ═════════════════════════════════════════
  card({ type: 'chapter', durationSec: 2.6, eyebrow: 'Three', title: 'What survives the call' });

  // Stop the live session so the save prompt fires the way it does for a user.
  await optional(dashboard, 'the save prompt', async () => {
    if (!liveId) throw new Error('no live session');
    await dashboard.evaluate(async ([sid]) => (window as any).api.session.stop(sid), [liveId] as const);
    await dashboard.waitForTimeout(1800);
    const prompt = dashboard.getByRole('dialog');
    await prompt.waitFor({ timeout: 8000 });
    await shot(dashboard, {
      dir: '16-save',
      kicker: 'When it ends',
      caption: 'One decision, once: keep this conversation, and which Space it belongs to.',
      hold: 4.6,
    });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(600);
  });

  /**
   * Keep ONE standup — the older of the two. Its memories arrive pending.
   *
   * The order here is the whole memory act, and getting it wrong is what made
   * the conflict scene impossible on the first take. `memory.conflicts()` pairs
   * a PENDING candidate against a CURRENT one, and "current" means approved
   * (memories.repo.ts → currentByFactKey). Keep both standups back to back and
   * every candidate is pending, so nothing can conflict with anything and the
   * run reports "the extractor found no contradiction" — blaming the model for
   * a sequencing mistake.
   *
   * So the act runs the loop the way a person does: keep week one, approve it,
   * and only then keep week two, where the same fact now has a different value.
   */
  const keep = (which: number) =>
    dashboard.evaluate(
      async ([pid, idx]) => {
        const a = (window as any).api;
        const sessions = await a.session.list(pid);
        const standups = sessions
          .filter((s: any) => /standup/i.test(s.jobTitle ?? ''))
          .sort((x: any, y: any) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
        const s = standups[idx as number];
        if (!s) return null;
        return a.session.remember(s.id, s.jobId ?? null);
      },
      [profileId, which] as const,
    );

  console.log(`  kept week one → ${JSON.stringify(await keep(0))}`);

  await optional(dashboard, 'sessions', async () => {
    await nav('sessions');
    await shot(dashboard, {
      dir: '17-sessions',
      kicker: 'Sessions',
      caption: 'Every conversation, with its full transcript, in a database on your disk.',
    });
  });

  await optional(dashboard, 'meeting report', async () => {
    if (!standupId) throw new Error('no standup Space');
    const reported = await dashboard.evaluate(async (pid) => {
      const a = (window as any).api;
      const sessions = await a.session.list(pid);
      const s = sessions.find((x: any) => /standup/i.test(x.jobTitle ?? ''));
      if (!s) return null;
      await a.session.meetingReport(s.id);
      return s.id as string;
    }, profileId);
    if (!reported) throw new Error('no standup session');
    await nav('sessions');
    // Row-scoped: the newest session is the interview that just ended, and its
    // Report button opens the coaching report instead — a different modal
    // saying nothing about meetings.
    await dashboard
      .getByRole('row')
      .filter({ hasText: /standup/i })
      .first()
      .getByRole('button', { name: /^report$/i })
      .click();
    await dashboard.getByRole('dialog').waitFor({ timeout: 20_000 });
    await dashboard.waitForTimeout(1200);
    await shot(dashboard, {
      dir: '18-report',
      kicker: 'After a meeting',
      caption: 'Decisions, action items and open questions — quoted from what was actually said.',
      hold: 5.0,
    });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  await optional(dashboard, 'memory review queue', async () => {
    await nav('memory');
    await dashboard.waitForTimeout(1200);
    await scrollBy(dashboard, 330);
    await dashboard.waitForTimeout(500);
    await shot(dashboard, {
      dir: '19-memory-review',
      kicker: 'Memory',
      caption: 'It proposes what seems worth remembering. It never decides.',
      hold: 5.0,
      // "Approve" becomes "Replace" when the candidate supersedes a fact
      // already remembered (MemoryPage.tsx), so the spotlight must accept both
      // or it silently finds nothing on exactly the runs that matter most.
      spotlight: {
        of: dashboard.getByRole('button', { name: /^(approve|replace)$/i }).first(),
        label: 'your call',
      },
    });
  });

  // Approve everything week one proposed. This is both the next scene and the
  // precondition for the two after it: nothing can be superseded, and nothing
  // can be recalled, until something is actually approved.
  const approved = await dashboard.evaluate(async (pid) => {
    const a = (window as any).api;
    const pending = await a.memory.list(pid, { status: 'pending' });
    for (const m of pending) await a.memory.review(m.id, 'approve');
    return pending.length as number;
  }, profileId);
  console.log(`  approved ${approved} memor${approved === 1 ? 'y' : 'ies'}`);

  await optional(dashboard, 'memory approved', async () => {
    if (!approved) throw new Error('nothing was proposed to approve');
    await nav('home');
    await nav('memory'); // remount so the table refetches
    await dashboard.waitForTimeout(1100);
    await scrollBy(dashboard, 460);
    await dashboard.waitForTimeout(500);
    await shot(dashboard, {
      dir: '20-memory-approved',
      caption: 'Only what you approve is ever recalled. Everything else expires unremembered.',
      hold: 4.4,
    });
  });

  // Now week two, where the same fact has a different value: phase two moved
  // from September to October. Its candidates land pending against an approved
  // current one, which is exactly what a conflict is.
  console.log(`  kept week two → ${JSON.stringify(await keep(1))}`);

  await optional(dashboard, 'a fact that changed', async () => {
    const conflicts = await dashboard.evaluate(
      async (pid) => (window as any).api.memory.conflicts(pid),
      profileId,
    );
    const n = Array.isArray(conflicts) ? conflicts.length : 0;
    console.log(`  conflicts: ${n}`);
    if (!n) throw new Error('the extractor gave the two values different fact keys this run');
    await nav('home');
    await nav('memory');
    await dashboard.waitForTimeout(1200);
    await scrollBy(dashboard, 330);
    await dashboard.waitForTimeout(400);
    await shot(dashboard, {
      dir: '21-conflict',
      kicker: 'When a fact changes',
      caption: 'September became October. It says so — instead of quietly believing both.',
      hold: 5.4,
      spotlight: {
        of: dashboard.getByRole('button', { name: /^replace$/i }).first(),
        label: 'replace, not accumulate',
      },
    });
  });

  // The payoff for the whole act: a NEW conversation in that Space, where an
  // approved memory is actually recalled. Everything before this is bookkeeping
  // if this does not happen.
  await optional(dashboard, 'memory recalled in a new session', async () => {
    if (!standupId) throw new Error('no standup Space');
    const sid = await dashboard.evaluate(
      async ([pid, jid]) => {
        const a = (window as any).api;
        const s = await a.session.start(pid, undefined, jid, 'key_points', 'meeting');
        return s.id as string;
      },
      [profileId, standupId] as const,
    );
    await dashboard.evaluate(async () => {
      await (window as any).api.overlay.setMode('expanded');
    });
    const asking = dashboard
      .evaluate(
        async ([s]) =>
          (window as any).api.session.ask(s, 'Where did we land on the phase two start date?'),
        [sid] as const,
      )
      .catch(() => {}); // started, not awaited — see 10-grounded
    await clip(
      overlay,
      {
        dir: '22-recall',
        kicker: 'A week later',
        caption: 'The next conversation in that Space already knows what the last one settled.',
        fps: 10,
        tailHold: 3.4,
      },
      { intervalMs: 110, settleMs: 900, minGrowth: 160, maxFrames: 200, startTimeoutMs: 60_000 },
    );
    await asking;
    await dashboard.evaluate(async ([s]) => (window as any).api.session.stop(s), [sid] as const);
    await dashboard.waitForTimeout(1500);
  });

  await optional(dashboard, 'the next interview', async () => {
    if (!googleId) throw new Error('no interview Space');
    await go('#/library?tab=spaces', 1000);
    await dashboard.getByRole('button', { name: /^brief$/i }).first().click();
    const brief = dashboard.getByRole('dialog');
    await brief.waitFor({ timeout: 20_000 });
    // The dialog opens IMMEDIATELY, on a spinner — the brief itself is a model
    // call that takes several seconds. Shooting the dialog is how the first take
    // captured "Analysing your résumé against this role…" under a caption about
    // continuity. Wait for the spinner to go, not for the dialog to arrive.
    await brief
      .getByText(/analysing your résumé/i)
      .waitFor({ state: 'hidden', timeout: 120_000 })
      .catch(() => {});
    await dashboard.waitForTimeout(1200);
    await shot(dashboard, {
      dir: '23-brief',
      kicker: 'Next time',
      caption: 'And an interview opens with a brief built from the role and everything you have said.',
      hold: 5.0,
    });
    await dashboard.keyboard.press('Escape');
    await dashboard.waitForTimeout(400);
  });

  // ══ Act 4 · It is yours ════════════════════════════════════════════════════
  card({ type: 'chapter', durationSec: 2.6, eyebrow: 'Four', title: 'It is yours' });

  await optional(dashboard, 'the key', async () => {
    await nav('settings');
    const key = dashboard.locator('[data-tour="settings-key"]');
    await key.first().scrollIntoViewIfNeeded().catch(() => {});
    await dashboard.waitForTimeout(500);
    await shot(dashboard, {
      dir: '24-key',
      kicker: 'Your key, your account',
      caption: 'The OpenAI key is encrypted by the OS and never leaves the main process.',
      hold: 4.6,
      spotlight: { of: key, label: 'never sent to the UI' },
    });
  });

  await optional(dashboard, 'insights', async () => {
    await nav('reports');
    await shot(dashboard, {
      dir: '25-insights',
      kicker: 'Insights',
      caption: 'Trends across every conversation you kept — still only on this machine.',
    });
  });

  await optional(dashboard, 'outro home', async () => {
    await nav('home');
    await shot(dashboard, {
      dir: '26-home',
      caption: 'One companion, for every conversation you actually have.',
      hold: 4.0,
    });
  });

  card({
    type: 'title',
    logo: true,
    durationSec: 5.0,
    eyebrow: 'BrainCue',
    title: 'Free, open source,\nand local-first.',
    subtitle: 'github.com/tpikachu/BrainCue',
  });

  // ── The assembly contract ────────────────────────────────────────────────
  writeFileSync(
    resolve(DEMO, 'manifest.json'),
    JSON.stringify({ version: 2, ...CANVAS, fps: 30, scenes }, null, 2),
    'utf8',
  );

  const shots = scenes.filter((s) => s.type !== 'title' && s.type !== 'chapter').length;
  console.log(`\n  manifest: ${scenes.length} scenes (${shots} captured, ${skipped.length} skipped)`);
  if (skipped.length) console.log(skipped.map((s) => `    - ${s}`).join('\n'));
  if (shots < 12) throw new Error(`only ${shots} scenes captured — the film would be a stub`);
});
