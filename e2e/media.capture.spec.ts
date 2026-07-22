import { test, hasKey, setApiKey } from './fixtures';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// Opt-in capture utility — records the ANIMATED clips (the GIFs / demo video)
// used by the README and the landing page, as numbered PNG frames:
//
//   E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts
//   node scripts/build-media.mjs cue-card-stream --fps 12 --width 760
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

/** Burst `count` screenshots every `everyMs` into docs/media/frames/<clip>/. */
async function burst(page: Page, clip: string, count: number, everyMs: number): Promise<void> {
  const dir = resolve(FRAMES, clip);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await page.screenshot({ path: resolve(dir, `frame-${String(i).padStart(4, '0')}.png`) });
    await page.waitForTimeout(everyMs);
  }
}

test('@capture cue-card streaming clip', async ({ dashboard }) => {
  test.skip(!hasKey, 'needs OPENAI_API_KEY — the clip is a real streamed answer');
  test.setTimeout(300_000);

  await setApiKey(dashboard);
  await dashboard.evaluate(async () => {
    await (window as any).api.privacy.set(false);
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

  // Start a mock: the AI interviewer asks aloud, the answer streams into the
  // Cue Card. Begin bursting immediately so the clip catches the transcript
  // appearing AND the answer streaming in.
  await dashboard.evaluate(
    async (pid) => (window as any).api.mock.start(pid, 'alloy', null, 'behavioral'),
    profileId,
  );

  // ~18s at 3 fps → 54 frames; ffmpeg retimes to the output fps.
  await burst(overlay, 'cue-card-stream', 54, 330);

  await dashboard.evaluate(async () => {
    const api = (window as any).api;
    const r = await api.session.list();
    if (r[0]) await api.mock.end(r[0].id);
  });
});
