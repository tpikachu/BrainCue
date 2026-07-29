#!/usr/bin/env node
/**
 * Render the drawn explainer loops from media-src/explainers.html.
 *
 *   node scripts/build-explainers.mjs            # all of them
 *   node scripts/build-explainers.mjs grounding  # just one
 *
 * Writes frames to docs/media/frames/explainers/<name>/, then
 * scripts/build-media.mjs cuts each into docs/media/<name>.gif.
 *
 * Rendered in **Electron**, not a browser: the e2e harness deliberately does
 * not install Playwright's bundled browsers (it drives this project's own
 * Electron over CDP), so there is no Chromium on disk to point at. Electron is
 * already a dependency, `webContents.capturePage()` gives an exact off-screen
 * capture at a fixed size, and the whole thing runs with no display attached —
 * which a Playwright-based version would not.
 *
 * The frames are deleted and re-rendered every run: an explainer is source
 * code, and a stale frame directory is how a diagram and the sentence it is
 * supposed to illustrate quietly stop matching.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const require_ = createRequire(resolve(ROOT, 'package.json'));
const electronBin = require_('electron');

const OUT = resolve(ROOT, 'docs/media/frames/explainers');
const PAGE = resolve(ROOT, 'media-src/explainers.html');

/** Must match `LOOP_MS` in explainers.html — one cycle, so the GIF loops. */
const LOOP_MS = 8000;
/**
 * 10 fps, not 15.
 *
 * An explainer changes state five times in eight seconds and holds in between;
 * the only genuinely moving parts are the 0.45s ease on each change. At 15 fps
 * that is 120 frames for five beats and a ~1 MB GIF — a third of a README's
 * weight to animate a diagram nobody is studying frame by frame.
 */
const FPS = 10;
/** Rendered at 1200 to match stealth-split, delivered at 900 — the widest any
 *  of these is displayed, on the landing page. */
const SIZE = { width: 1200, height: 675 };
const DELIVER_WIDTH = 900;

/**
 * Every explainer, and the sentence it exists to make.
 *
 * `stealth-split` is NOT here: it predates this rig and is still the hand-made
 * asset. It is the model the others were drawn to match, and it should be
 * ported into explainers.html the next time it needs a change.
 */
export const EXPLAINERS = [
  { name: 'memory-loop', claim: 'nothing is remembered without your approval' },
  { name: 'grounding', claim: 'your documents stay put; only the matches are sent' },
  { name: 'activities', claim: 'you pick the conversation, not the mode' },
];

const only = process.argv[2];
const targets = only ? EXPLAINERS.filter((e) => e.name === only) : EXPLAINERS;
if (!targets.length) {
  console.error(`unknown explainer "${only}" — one of: ${EXPLAINERS.map((e) => e.name).join(', ')}`);
  process.exit(2);
}

// The renderer script, written out so Electron has a real main file to run.
const MAIN = resolve(OUT, '_render.cjs');
mkdirSync(OUT, { recursive: true });
writeFileSync(
  MAIN,
  `const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const [page, outDir, names, loopMs, fps, w, h] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration(); // deterministic raster: no GPU timing in the frames
app.whenReady().then(async () => {
  for (const name of names.split(',')) {
    const win = new BrowserWindow({
      width: Number(w), height: Number(h), show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await win.loadURL('file://' + page.replace(/\\\\/g, '/') + '?e=' + name);
    await wait(600); // fonts + first paint

    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const total = Math.round((Number(loopMs) / 1000) * Number(fps));
    const step = Number(loopMs) / total;
    for (let i = 0; i < total; i++) {
      const img = await win.webContents.capturePage();
      writeFileSync(join(dir, 'frame-' + String(i).padStart(4, '0') + '.png'), img.toPNG());
      await wait(step);
    }
    console.log('  ' + name + ': ' + total + ' frames');
    win.destroy();
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
`,
  'utf8',
);

for (const t of targets) rmSync(resolve(OUT, t.name), { recursive: true, force: true });

console.log(`rendering ${targets.length} explainer(s) at ${SIZE.width}x${SIZE.height}, ${FPS} fps`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // or Electron boots as plain node and there is no app

const r = spawnSync(
  electronBin,
  [
    MAIN, PAGE, OUT,
    targets.map((t) => t.name).join(','),
    String(LOOP_MS), String(FPS), String(SIZE.width), String(SIZE.height),
  ],
  { stdio: 'inherit', env, cwd: ROOT },
);
if (r.status !== 0) {
  console.error(`render failed (exit ${r.status})`);
  process.exit(r.status ?? 1);
}

// Cut each to a GIF. No caption is passed: an explainer carries its own words,
// and a second caption bar on top of them is just noise.
for (const t of targets) {
  const out = spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'scripts/build-media.mjs'),
      `explainers/${t.name}`,
      '--out', t.name,
      '--fps', String(FPS),
      '--width', String(DELIVER_WIDTH),
      '--hold', '999', // an explainer holds on purpose; never trim its still beats
      '--gif-only',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
  if (out.status !== 0) process.exit(out.status ?? 1);
}

console.log('\n✓ explainers built');
