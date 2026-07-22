#!/usr/bin/env node
/**
 * Assemble frames captured by e2e/media.capture.spec.ts into the media that
 * the README and the landing page (docs/index.html) reference.
 *
 * Single clip (GIF + MP4):
 *   node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--hold 4] [--gif-only]
 *   Reads  docs/media/frames/<clip>/frame-%04d.png
 *   Writes docs/media/<clip>.gif  and  docs/media/<clip>.mp4
 *
 * Captioned multi-scene video (the demo):
 *   node scripts/build-media.mjs --manifest docs/media/frames/demo/manifest.json --out braincue-demo
 *   The manifest lists scenes `{dir, caption, holdSec?|fps?, tailHoldSec?}`;
 *   each scene becomes a segment with its caption burned in (drawtext), scaled
 *   and padded onto one canvas, then all segments concat into
 *   docs/media/<out>.mp4. Still scenes use `holdSec` (single frame held);
 *   streamed scenes use `fps` (+ optional `tailHoldSec` freeze on the last
 *   frame so the payoff is readable before the cut).
 *
 * Requires ffmpeg on PATH (https://ffmpeg.org/download.html — on Windows:
 * `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`).
 *
 * The GIF is built with a two-pass palette: a single global palette makes
 * flat UI screenshots (large areas of one colour, thin text) come out sharp
 * and small, where ffmpeg's default 256-colour quantisation smears them.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

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
// Max frames kept from any run of identical frames (the idle head / finished tail).
const holdFrames = Number(flag('hold', 4));

const manifestPath = flag('manifest', null);

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

// `_`-prefixed files are our own artefacts (staging dirs, palette), not frames.
const isFrame = (f) => f.endsWith('.png') && !f.startsWith('_');

/** Escape a value for use inside an ffmpeg filter option ('quoted', : escaped). */
const fesc = (s) => `'${s.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

/** First present system font usable for drawtext captions. */
function captionFont() {
  const candidates = [
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

if (manifestPath) {
  buildFromManifest(resolve(manifestPath), flag('out', 'braincue-demo'));
  process.exit(0);
}

if (!clip) {
  console.error(
    'usage: node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--gif-only]\n' +
      '   or: node scripts/build-media.mjs --manifest <manifest.json> --out <name>',
  );
  process.exit(2);
}

const frameDir = resolve(MEDIA, 'frames', clip);
if (!existsSync(frameDir)) {
  console.error(`No frames at ${frameDir}\nCapture them first:\n  E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts`);
  process.exit(1);
}
const frameCount = readdirSync(frameDir).filter(isFrame).length;
if (!frameCount) {
  console.error(`${frameDir} has no PNG frames.`);
  process.exit(1);
}

/**
 * Collapse runs of byte-identical frames.
 *
 * The app idles before the answer starts and holds still after it finishes, so
 * a raw capture is bookended by long stretches of the same image — which is
 * what makes a clip read as a static screenshot. Keep at most `hold` frames of
 * any repeated run, so the pauses register as a beat without dominating.
 */
function dedupeRuns(dir, files, hold) {
  const kept = [];
  let prevHash = null;
  let run = 0;
  for (const f of files) {
    const hash = createHash('sha1').update(readFileSync(resolve(dir, f))).digest('hex');
    run = hash === prevHash ? run + 1 : 0;
    prevHash = hash;
    if (run < hold) kept.push(f);
  }
  return kept;
}

mkdirSync(MEDIA, { recursive: true });

// ffmpeg needs a gapless frame-%04d sequence, so stage the kept frames.
const allFrames = readdirSync(frameDir).filter(isFrame).sort();
const kept = dedupeRuns(frameDir, allFrames, holdFrames);
const stage = resolve(frameDir, '_staged');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
kept.forEach((f, i) => copyFileSync(resolve(frameDir, f), resolve(stage, `frame-${String(i).padStart(4, '0')}.png`)));
if (kept.length !== allFrames.length) {
  console.log(`  trimmed ${allFrames.length - kept.length} duplicate frame(s) (kept ${kept.length})`);
}

const input = resolve(stage, 'frame-%04d.png');
const scale = `scale=${width}:-1:flags=lanczos`;
const palette = resolve(stage, '_palette.png');

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

/**
 * Manifest mode: per-scene segments (scale+pad to one canvas, caption burned
 * in at the bottom) concatenated into docs/media/<out>.mp4.
 */
function buildFromManifest(path, outName) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(path);
  const W = manifest.width ?? 1280;
  const H = manifest.height ?? 800;
  const font = captionFont();
  if (!font) console.warn('  ! no caption font found — building without captions');

  const segDir = resolve(base, '_segments');
  rmSync(segDir, { recursive: true, force: true });
  mkdirSync(segDir, { recursive: true });

  const canvas =
    `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#0a0a0b`;

  const segments = [];
  manifest.scenes.forEach((scene, idx) => {
    const dir = resolve(base, scene.dir);
    const files = readdirSync(dir).filter(isFrame).sort();
    if (!files.length) {
      console.error(`scene ${scene.dir}: no frames`);
      process.exit(1);
    }

    // Caption via textfile= so no caption text ever needs filter escaping.
    let caption = '';
    if (scene.caption && font) {
      const txt = resolve(dir, '_caption.txt');
      writeFileSync(txt, scene.caption, 'utf8');
      caption =
        `,drawtext=textfile=${fesc(txt)}:fontfile=${fesc(font)}` +
        ':fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12' +
        ':x=(w-text_w)/2:y=h-52';
    }
    // Freeze the last frame so a streamed scene's payoff stays readable.
    const tail = scene.tailHoldSec ? `,tpad=stop_mode=clone:stop_duration=${scene.tailHoldSec}` : '';

    const out = resolve(segDir, `${String(idx).padStart(2, '0')}.mp4`);
    if (scene.fps) {
      // Streamed scene: real frame sequence (trim idle runs first).
      const kept = dedupeRuns(dir, files, holdFrames);
      const stageDir = resolve(dir, '_staged');
      rmSync(stageDir, { recursive: true, force: true });
      mkdirSync(stageDir, { recursive: true });
      kept.forEach((f, i) =>
        copyFileSync(resolve(dir, f), resolve(stageDir, `frame-${String(i).padStart(4, '0')}.png`)),
      );
      ff([
        '-y', '-framerate', String(scene.fps), '-i', resolve(stageDir, 'frame-%04d.png'),
        '-vf', `${canvas}${tail}${caption},fps=24`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '24',
        out,
      ]);
    } else {
      // Still scene: hold one frame (the last — it's the settled state).
      ff([
        '-y', '-loop', '1', '-framerate', '24', '-t', String(scene.holdSec ?? 3),
        '-i', resolve(dir, files[files.length - 1]),
        '-vf', `${canvas}${caption},fps=24`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '24',
        out,
      ]);
    }
    segments.push(out);
    console.log(`  segment ${scene.dir} ✓`);
  });

  const list = resolve(segDir, 'list.txt');
  writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const outPath = resolve(MEDIA, `${outName}.mp4`);
  // Re-encode on concat: byte-identical params across segments aren't worth
  // betting the final artifact on when the re-encode is this cheap.
  ff([
    '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    '-movflags', '+faststart', '-an',
    outPath,
  ]);
  console.log(`  ✓ docs/media/${outName}.mp4`);
}
