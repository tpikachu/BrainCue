import { test, disablePrivacyMode, hasKey, setApiKey } from './fixtures';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// Opt-in capture utility — records the ANIMATED clips (the GIFs / demo video)
// used by the README and the landing page, as numbered PNG frames:
//
//   E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts
//   node scripts/build-media.mjs cuecard-stream --fps 12 --width 760
//
// See e2e/README.md § Capturing marketing media.
//
// Why frames and not Playwright video: the harness attaches to an already
// running Electron over CDP (fixtures.ts), and recordVideo is a browser-context
// creation option — it can't be turned on for a context we merely connected to.
// Bursting screenshots works over CDP, is deterministic, and lets ffmpeg pick
// the frame rate afterwards.
/* eslint-disable @typescript-eslint/no-explicit-any */
const FRAMES = resolve(process.cwd(), 'docs/media/frames');

/**
 * Capture the interesting part of a stream and nothing else.
 *
 * A fixed-length burst is the wrong tool here: most of the wall-clock time is
 * spent waiting for the interviewer's TTS and transcription, and the answer
 * itself streams in a couple of seconds — so a fixed window yields a long tail
 * of byte-identical frames and the clip reads as a still image.
 *
 * Instead: idle until the page's text actually starts growing, then sample
 * densely until it stops growing (plus a short settle so the finished answer
 * holds on screen for a beat).
 */
async function captureStream(
  page: Page,
  clip: string,
  opts: {
    intervalMs: number;
    settleMs: number;
    maxFrames: number;
    startTimeoutMs: number;
    /** Characters that must accumulate before "text stopped changing" is
     *  allowed to mean "finished". Without this the capture ends during the
     *  quiet gap between the question landing and the first answer token —
     *  which is how the clip came out as 11 near-identical frames. */
    minGrowth: number;
  },
): Promise<number> {
  const dir = resolve(FRAMES, clip);
  rmSync(dir, { recursive: true, force: true }); // never mix frames across runs
  mkdirSync(dir, { recursive: true });

  const textLen = () =>
    page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().length);

  // 1 · Wait for content to start arriving (question transcribed → answer opens).
  const baseline = await textLen();
  const startBy = Date.now() + opts.startTimeoutMs;
  while (Date.now() < startBy) {
    if ((await textLen()) > baseline + 40) break;
    await page.waitForTimeout(200);
  }

  // 2 · Sample while it grows. Stop only once enough text has actually arrived
  //     AND it has then held still for settleMs — so a mid-stream pause (or the
  //     gap before the first answer token) can't be mistaken for the end.
  const from = await textLen();
  let frames = 0;
  let lastLen = -1;
  let stableMs = 0;
  let peak = from;
  while (frames < opts.maxFrames) {
    await page.screenshot({ path: resolve(dir, `frame-${String(frames).padStart(4, '0')}.png`) });
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

test('@capture cue-card streaming clip', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY — the clip is a real streamed answer');
  test.setTimeout(300_000);

  await setApiKey(dashboard);
  // Windows must be capturable, and the guided tour must not cover them. The
  // tour is already suppressed by fixtures.ts (tourDone is set before the
  // renderer boots, so it can never mount over the capture).
  await disablePrivacyMode(dashboard);
  await dashboard.evaluate(async () => {
    await (window as any).api.overlay.setMode('expanded');
  });

  const { profileId } = await dashboard.evaluate(async () =>
    (window as any).api.data.loadSamples(),
  );

  const overlay = dashboard
    .context()
    .pages()
    .find((p) => p.url().includes('view=overlay'));
  if (!overlay) throw new Error('overlay window not found — is the Cue Card open?');

  // Start a mock: the AI interviewer asks aloud, then the answer streams into
  // the Cue Card.
  //
  // Deliberately NOT awaited. `mock.start` only resolves once the question has
  // been asked AND answered, so awaiting it means capture begins after the
  // interesting part is already over — which is exactly why the first version
  // of this clip came out as a static image of a finished answer. Kick it off
  // and start sampling immediately; captureStream idles until text appears.
  const running = dashboard
    .evaluate(
      async (pid) => (window as any).api.mock.start(pid, 'alloy', null, 'behavioral'),
      profileId,
    )
    .catch(() => {
      /* the run is torn down below; a late rejection must not fail the capture */
    });

  // The clip name matches the committed asset (docs/media/cuecard-stream.gif),
  // so a re-capture refreshes it in place with no README/landing-page churn.
  const frames = await captureStream(overlay, 'cuecard-stream', {
    intervalMs: 100, // the answer streams in ~1s — sample fine or it's a jump cut
    settleMs: 700, // brief hold on the finished answer (build-media trims the rest)
    minGrowth: 250, // an answer's worth of text must land before we call it done
    maxFrames: 300, // hard cap (~30s of capture)
    startTimeoutMs: 90_000, // spoken question + transcription can be slow
  });
  console.log(`cuecard-stream: captured ${frames} frames`);
  await running;

  await dashboard.evaluate(async () => {
    const api = (window as any).api;
    const r = await api.session.list();
    if (r[0]) await api.mock.end(r[0].id);
  });
});

/**
 * Dashboard walkthrough — the frames behind TWO assets:
 *
 * - `braincue-demo.mp4` — a captioned scene-by-scene walkthrough of the app.
 *   Frames land in frames/demo/<scene>/ plus a manifest.json with the caption
 *   and pacing for each scene; assemble with
 *   `node scripts/build-media.mjs --manifest docs/media/frames/demo/manifest.json --out braincue-demo`
 *
 * - `interview-grounded.gif` — the dashboard grounding story (Home → Library →
 *   the interview workspace with a profile picked and its Spaces listed).
 *   Frames land in frames/interview-grounded/; assemble with
 *   `node scripts/build-media.mjs interview-grounded --fps 1.2 --hold 2 --width 640`
 *
 * Exists because the old assets showed the pre-mode-first dashboard (flat
 * interview-only sidebar) — any layout change makes them stale, and this spec
 * is how they get refreshed from the real app instead of by hand.
 */
test('@capture dashboard walkthrough (demo scenes + grounded gif)', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY to seed parsed sample data + stream an answer');
  test.setTimeout(300_000);

  await setApiKey(dashboard);
  await disablePrivacyMode(dashboard);

  const { profileId } = await dashboard.evaluate(async () =>
    (window as any).api.data.loadSamples(),
  );

  // Fresh frame dirs (a stale run's frames must never leak into the assembly).
  const DEMO = resolve(FRAMES, 'demo');
  const IG = resolve(FRAMES, 'interview-grounded');
  rmSync(DEMO, { recursive: true, force: true });
  rmSync(IG, { recursive: true, force: true });
  mkdirSync(IG, { recursive: true });

  const counters = new Map<string, number>();
  const snap = async (page: Page, dir: string): Promise<void> => {
    const n = counters.get(dir) ?? 0;
    counters.set(dir, n + 1);
    const abs = resolve(FRAMES, dir);
    mkdirSync(abs, { recursive: true });
    await page.screenshot({ path: resolve(abs, `frame-${String(n).padStart(4, '0')}.png`) });
  };
  // HashRouter: navigation is just the hash.
  const go = async (route: string): Promise<void> => {
    await dashboard.evaluate((r) => {
      window.location.hash = r;
    }, route);
    await dashboard.waitForTimeout(900);
  };

  // ── Scene 1 · Home, the launcher ──────────────────────────────────────────
  await go('#/home');
  await dashboard.getByRole('heading', { name: /how can braincue help/i }).waitFor();
  await snap(dashboard, 'demo/01-home');
  await snap(dashboard, 'interview-grounded');

  // ── Scene 2 · The start flow (modes + the transparency panel) ─────────────
  await dashboard.getByRole('button', { name: /start listening/i }).first().click();
  await dashboard.getByRole('dialog').waitFor();
  await dashboard.waitForTimeout(500);
  await snap(dashboard, 'demo/02-start');
  await dashboard.keyboard.press('Escape');

  // ── Scene 3 · Library: Spaces + documents (what grounds the answers) ──────
  await go('#/library?tab=spaces');
  await snap(dashboard, 'interview-grounded');
  await go('#/library?tab=documents');
  await snap(dashboard, 'interview-grounded');

  // ── Scene 4 · The interview workspace: profile picked, Spaces listed ──────
  await go('#/interview');
  // The profile picker is the in-window Dropdown (never a native <select>).
  // Target its VISIBLE TEXT, not a role+name pair: the Field wraps the
  // dropdown's <button> in a <label>, so the button's accessible name is the
  // label ("Profile"), not its own contents — a name lookup never matches.
  await dashboard.getByText('Select a profile…').click();
  await dashboard.getByRole('listbox').waitFor();
  await dashboard.getByRole('option').nth(1).click(); // 0 = the placeholder
  await dashboard.getByText(/Google|Amazon|Stripe/).first().waitFor();
  await dashboard.waitForTimeout(600);
  await snap(dashboard, 'demo/03-grounded');
  await snap(dashboard, 'interview-grounded');
  await snap(dashboard, 'interview-grounded'); // hold the payoff view a beat longer

  // ── Scene 5 · The Cue Card: a real answer streaming in ────────────────────
  await dashboard.evaluate(async () => {
    await (window as any).api.overlay.setMode('expanded');
  });
  const overlay = dashboard
    .context()
    .pages()
    .find((p) => p.url().includes('view=overlay'));
  if (!overlay) throw new Error('overlay window not found — is the Cue Card open?');
  const running = dashboard
    .evaluate(
      async (pid) => (window as any).api.mock.start(pid, 'alloy', null, 'behavioral'),
      profileId,
    )
    .catch(() => {});
  const frames = await captureStream(overlay, 'demo/04-cuecard', {
    intervalMs: 100,
    settleMs: 700,
    minGrowth: 250,
    maxFrames: 300,
    startTimeoutMs: 90_000,
  });
  console.log(`demo/04-cuecard: captured ${frames} frames`);
  await running;
  await dashboard.evaluate(async () => {
    const api = (window as any).api;
    const r = await api.session.list();
    if (r[0]) await api.mock.end(r[0].id);
  });

  // The demo ends on the Cue Card payoff (a mock session never persists —
  // mock.end tears down and deletes — so a Sessions scene would show an
  // empty table and read as broken).

  // The manifest is the assembly contract for build-media.mjs --manifest.
  writeFileSync(
    resolve(DEMO, 'manifest.json'),
    JSON.stringify(
      {
        width: 1280,
        height: 800,
        scenes: [
          { dir: '01-home', holdSec: 3, caption: 'BrainCue - the AI that is in the room with you' },
          { dir: '02-start', holdSec: 4, caption: 'One start flow for every mode - see exactly what leaves your machine, before anything starts' },
          { dir: '03-grounded', holdSec: 3.5, caption: 'Grounded in your documents - resume, job description, company research' },
          { dir: '04-cuecard', fps: 10, tailHoldSec: 2.5, caption: 'A question is heard - a cited answer streams into the screen-share-invisible Cue Card' },
        ],
      },
      null,
      2,
    ),
  );
});
