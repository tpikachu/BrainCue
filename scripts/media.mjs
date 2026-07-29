#!/usr/bin/env node
/**
 * One entry point for the whole media pipeline. See docs/21-MEDIA.md.
 *
 *   npm run media            # capture everything, then build everything
 *   npm run media -- film    # assemble the video from frames already on disk
 *   npm run media -- gifs    # rebuild only the per-feature GIFs
 *   npm run media -- check   # is ffmpeg able to do this at all?
 *
 * Subcommands:
 *   check    ffmpeg capability report (no capture, no build)
 *   shots    capture the still images        → docs/images/*.png
 *   scenes   capture the film's frames       → docs/media/frames/demo/**
 *   film     assemble the film from frames   → docs/media/braincue-demo.mp4
 *   gifs     cut the per-feature GIFs        → docs/media/*.gif
 *   build    film + gifs (no capture)
 *   all      shots + scenes + film + gifs    (the default)
 *
 * Exists because the capture step needs an environment variable set before
 * Playwright starts (`E2E_CAPTURE=1`, which is what un-ignores the *.capture
 * specs), and `E2E_CAPTURE=1 npx …` is a bash-ism that silently does nothing in
 * cmd.exe — so the documented command used to work for half the people who ran
 * it. Setting it here works the same on every platform.
 *
 * Prerequisites, both checked before anything runs:
 *   - OPENAI_API_KEY in .env — the answers in the film are real
 *   - ffmpeg on PATH with libass (`node scripts/media.mjs check`)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = resolve(ROOT, 'docs/media/frames/demo/manifest.json');

/**
 * The per-feature loops, each cut from a scene of the film.
 *
 * They come from the film's own frames rather than a separate capture, so a GIF
 * on the README and the corresponding moment in the video can never show two
 * different takes — and the expensive live run happens once.
 *
 * Width is deliberately small: these are inline loops in a README, and GitHub
 * will not autoplay a video, so the GIF is the delivery format rather than a
 * legacy one. 480px keeps them under a few hundred KB.
 */
const GIFS = [
  {
    scene: 'demo/09-cuecard',
    out: 'cuecard-stream',
    width: 420,
    fps: 10,
    caption: 'A question is heard — a grounded answer streams in.',
  },
  {
    scene: 'demo/10-grounded',
    out: 'grounded-answer',
    width: 480,
    fps: 10,
    caption: 'Built from your own material, with its sources.',
  },
  {
    scene: 'demo/12-star',
    out: 'format-switch',
    width: 420,
    fps: 10,
    caption: 'Re-tell the same answer as a STAR story.',
  },
  {
    scene: 'demo/13-coding',
    out: 'coding-solve',
    width: 420,
    fps: 10,
    caption: 'Capture a region — it solves what is in it.',
  },
];

const run = (cmd, args, label) => {
  console.log(`\n▸ ${label}`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32', // npx is a .cmd shim on Windows
    env: { ...process.env, E2E_CAPTURE: '1' },
  });
  if (r.status !== 0) {
    console.error(`\n${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
};

const node = (args, label) => run(process.execPath, args, label);
const playwright = (spec, label) => run('npx', ['playwright', 'test', spec], label);

/** The film is a real recording of a real app answering real questions. Without
 *  a key the capture specs skip themselves and leave the old assets in place,
 *  which looks like success until someone watches the output. */
function requireKey() {
  if (process.env.OPENAI_API_KEY) return;
  const env = resolve(ROOT, '.env');
  if (existsSync(env) && /^\s*OPENAI_API_KEY\s*=\s*\S/m.test(readFileSync(env, 'utf8'))) return;
  console.error(
    'No OPENAI_API_KEY (env or .env).\n' +
      'The capture specs skip without one, and every asset here is a recording of\n' +
      'the real app answering real questions — there is nothing to fall back to.',
  );
  process.exit(1);
}

const step = {
  check: () => node([resolve(ROOT, 'scripts/build-media.mjs'), '--check'], 'ffmpeg capabilities'),
  shots: () => {
    requireKey();
    playwright('e2e/screenshots.capture.spec.ts', 'capturing stills → docs/images/');
  },
  scenes: () => {
    requireKey();
    playwright('e2e/media.capture.spec.ts', 'capturing the film → docs/media/frames/demo/');
  },
  film: () => {
    if (!existsSync(MANIFEST)) {
      console.error(
        `No manifest at ${MANIFEST}\nCapture the scenes first:  npm run media -- scenes`,
      );
      process.exit(1);
    }
    node(
      [
        resolve(ROOT, 'scripts/build-media.mjs'),
        '--manifest', MANIFEST,
        '--out', 'braincue-demo',
        ...(process.env.BRAINCUE_DEMO_MUSIC ? ['--music', process.env.BRAINCUE_DEMO_MUSIC] : []),
      ],
      'assembling docs/media/braincue-demo.mp4',
    );
  },
  gifs: () => {
    for (const g of GIFS) {
      node(
        [
          resolve(ROOT, 'scripts/build-media.mjs'),
          g.scene,
          '--out', g.out,
          '--fps', String(g.fps),
          '--width', String(g.width),
          '--caption', g.caption,
          '--gif-only',
        ],
        `cutting docs/media/${g.out}.gif`,
      );
    }
  },
};
step.build = () => {
  step.film();
  step.gifs();
};
step.all = () => {
  step.check();
  step.shots();
  step.scenes();
  step.build();
};

const what = process.argv[2] ?? 'all';
if (!(what in step)) {
  console.error(`unknown step "${what}" — one of: ${Object.keys(step).join(', ')}`);
  process.exit(2);
}
step[what]();
console.log('\n✓ done');
