#!/usr/bin/env node
/**
 * Assemble a frame directory captured by e2e/media.capture.spec.ts into the
 * GIF + MP4 that the README and the landing page (docs/index.html) reference.
 *
 *   node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--gif-only]
 *
 * Reads  docs/media/frames/<clip>/frame-%04d.png
 * Writes docs/media/<clip>.gif  and  docs/media/<clip>.mp4
 *
 * Requires ffmpeg on PATH (https://ffmpeg.org/download.html — on Windows:
 * `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`).
 *
 * The GIF is built with a two-pass palette: a single global palette makes
 * flat UI screenshots (large areas of one colour, thin text) come out sharp
 * and small, where ffmpeg's default 256-colour quantisation smears them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MEDIA = resolve(ROOT, 'docs/media');

const argv = process.argv.slice(2);
const clip = argv.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const fps = Number(flag('fps', 12));
const width = Number(flag('width', 760));
const gifOnly = argv.includes('--gif-only');

if (!clip) {
  console.error('usage: node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--gif-only]');
  process.exit(2);
}

const frameDir = resolve(MEDIA, 'frames', clip);
if (!existsSync(frameDir)) {
  console.error(`No frames at ${frameDir}\nCapture them first:\n  E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts`);
  process.exit(1);
}
const frameCount = readdirSync(frameDir).filter((f) => f.endsWith('.png')).length;
if (!frameCount) {
  console.error(`${frameDir} has no PNG frames.`);
  process.exit(1);
}

const ff = (args) => {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') {
    console.error(
      'ffmpeg not found on PATH.\n' +
        '  Windows: winget install Gyan.FFmpeg\n' +
        '  macOS:   brew install ffmpeg\n' +
        '  Linux:   apt install ffmpeg',
    );
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`ffmpeg failed (${r.status}):\n${(r.stderr || '').split('\n').slice(-12).join('\n')}`);
    process.exit(1);
  }
};

mkdirSync(MEDIA, { recursive: true });
const input = resolve(frameDir, 'frame-%04d.png');
const scale = `scale=${width}:-1:flags=lanczos`;
const palette = resolve(frameDir, '_palette.png');

console.log(`${clip}: ${frameCount} frames → ${fps} fps, ${width}px wide`);

// GIF, two-pass palette.
ff(['-y', '-framerate', String(fps), '-i', input, '-vf', `fps=${fps},${scale},palettegen=stats_mode=diff`, palette]);
ff([
  '-y', '-framerate', String(fps), '-i', input, '-i', palette,
  '-lavfi', `fps=${fps},${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
  resolve(MEDIA, `${clip}.gif`),
]);
rmSync(palette, { force: true });
console.log(`  ✓ docs/media/${clip}.gif`);

// MP4 — smaller and higher quality than the GIF; the landing page prefers it,
// the README needs the GIF (github.com markdown won't autoplay video).
if (!gifOnly) {
  ff([
    '-y', '-framerate', String(fps), '-i', input,
    // yuv420p + even dimensions: required for QuickTime/Safari playback.
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`,
    '-movflags', '+faststart',
    resolve(MEDIA, `${clip}.mp4`),
  ]);
  console.log(`  ✓ docs/media/${clip}.mp4`);
}
