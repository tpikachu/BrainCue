#!/usr/bin/env node
/**
 * Assemble frames captured by e2e/media.capture.spec.ts into the media that the
 * README, the landing page (docs/index.html) and docs/21-MEDIA.md reference.
 *
 * Two modes.
 *
 * ── Single clip (GIF + MP4) ───────────────────────────────────────────────────
 *   node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--hold 4]
 *                                       [--out <name>] [--caption "…"] [--gif-only]
 *   Reads  docs/media/frames/<clip>/frame-%04d.png   (<clip> may be nested,
 *                                                     e.g. demo/12-cuecard)
 *   Writes docs/media/<out|clip>.gif  and  docs/media/<out|clip>.mp4
 *
 * ── Storyboard video (the demo) ───────────────────────────────────────────────
 *   node scripts/build-media.mjs --manifest docs/media/frames/demo/manifest.json \
 *                                --out braincue-demo [--music track.mp3]
 *
 * The manifest is a scene list the capture spec writes (schema in
 * docs/21-MEDIA.md § The manifest). Each scene becomes one silent segment on a
 * fixed canvas; the segments are then cross-faded into a single stream, and ONE
 * subtitle pass burns every caption, kicker and title over the result.
 *
 * Why the text is a subtitle track and not `drawtext` per segment:
 *
 *   The previous version burned a caption into each segment with drawtext. That
 *   forced every caption to live for exactly one segment, gave no way to fade
 *   one in, and put the escaping burden on the caption text — so a colon or an
 *   apostrophe in a caption could break the filtergraph, which is why the old
 *   captions were written with hyphens where they wanted em dashes.
 *
 *   libass takes styled text with fades, positions and per-line timing, applied
 *   once over the finished cut. Timing is computed from the segment durations
 *   MINUS the transitions, so a caption cannot drift out of sync with the scene
 *   it belongs to no matter how the pacing is retuned.
 *
 * Requires ffmpeg on PATH, built with libass and libfreetype (any recent
 * full build: `winget install Gyan.FFmpeg` · `brew install ffmpeg` ·
 * `apt install ffmpeg`). `--check` reports what is missing.
 *
 * GIFs are built with a two-pass global palette: one palette for the whole clip
 * keeps flat UI colour and thin text sharp, where ffmpeg's default per-frame
 * quantisation smears them.
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
const clip = argv.find((a) => !a.startsWith('--') && !isFlagValue(a));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
/** True if this bare token is the value of a preceding `--flag`. */
function isFlagValue(token) {
  const i = argv.indexOf(token);
  return i > 0 && argv[i - 1].startsWith('--');
}

const fps = Number(flag('fps', 12));
const width = Number(flag('width', 760));
const gifOnly = argv.includes('--gif-only');
// Max frames kept from any run of identical frames (the idle head / finished tail).
const holdFrames = Number(flag('hold', 4));
const manifestPath = flag('manifest', null);
const outName = flag('out', null);

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg plumbing
// ─────────────────────────────────────────────────────────────────────────────

const ff = (args, { label = 'ffmpeg' } = {}) => {
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
    console.error(
      `${label} failed (${r.status}):\n${(r.stderr || '').split('\n').slice(-16).join('\n')}`,
    );
    process.exit(1);
  }
};

/** What this ffmpeg build can do — checked up front so a 20-segment render
 *  can't die on the last command for a missing filter. */
function ffCapabilities() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (r.error) return null;
  const has = (name) => new RegExp(`\\s${name}\\s`).test(r.stdout);
  const cfg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout ?? '';
  return {
    subtitles: has('subtitles') && /--enable-libass/.test(cfg),
    xfade: has('xfade'),
    zoompan: has('zoompan'),
    gradients: has('gradients'),
    drawbox: has('drawbox'),
  };
}

if (argv.includes('--check')) {
  const caps = ffCapabilities();
  if (!caps) {
    console.error('ffmpeg not found on PATH.');
    process.exit(1);
  }
  for (const [k, v] of Object.entries(caps)) console.log(`${v ? '  ✓' : '  ✗'} ${k}`);
  const missing = Object.entries(caps).filter(([, v]) => !v);
  if (missing.length) {
    console.error(
      `\nMissing: ${missing.map(([k]) => k).join(', ')} — install a full ffmpeg build.`,
    );
    process.exit(1);
  }
  console.log('\nffmpeg can build every asset.');
  process.exit(0);
}

// `_`-prefixed files are our own artefacts (staging dirs, palette), not frames.
const isFrame = (f) => f.endsWith('.png') && !f.startsWith('_');

/** Escape a value for use inside an ffmpeg filter option ('quoted', : escaped). */
const fesc = (s) => `'${s.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

/** First present system font file, and the family name libass should ask for. */
function pickFont() {
  const candidates = [
    { file: 'C:/Windows/Fonts/segoeui.ttf', family: 'Segoe UI' },
    { file: 'C:/Windows/Fonts/arial.ttf', family: 'Arial' },
    { file: '/System/Library/Fonts/Helvetica.ttc', family: 'Helvetica' },
    { file: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', family: 'DejaVu Sans' },
  ];
  return candidates.find((c) => existsSync(c.file)) ?? null;
}

/**
 * Collapse runs of byte-identical frames.
 *
 * The app idles before an answer starts and holds still after it finishes, so a
 * raw capture is bookended by long stretches of the same image — which is what
 * makes a clip read as a static screenshot. Keep at most `hold` frames of any
 * repeated run, so the pauses register as a beat without dominating.
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

/** Copy frames into a gapless frame-%04d sequence ffmpeg can read. */
function stageFrames(dir, files) {
  const stage = resolve(dir, '_staged');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  files.forEach((f, i) =>
    copyFileSync(resolve(dir, f), resolve(stage, `frame-${String(i).padStart(4, '0')}.png`)),
  );
  return resolve(stage, 'frame-%04d.png');
}

// ─────────────────────────────────────────────────────────────────────────────
// ASS subtitles — every word on screen, in one styled track
// ─────────────────────────────────────────────────────────────────────────────

/** ASS colours are &HAABBGGRR — alpha first, then BLUE, GREEN, RED. */
const assColor = (hex, alphaHex = '00') => {
  const h = hex.replace('#', '');
  return `&H${alphaHex}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};

/** ASS timestamps are H:MM:SS.cc (centiseconds, one leading hour digit). */
function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(rest)).padStart(2, '0')}.${String(
    Math.round((rest % 1) * 100),
  ).padStart(2, '0')}`;
}

/**
 * Make caption text safe for an ASS Dialogue line.
 * `{`/`}` open and close override blocks, `\n` is a literal line break (`\N`),
 * and a trailing backslash would swallow the next character.
 */
const assText = (s) =>
  String(s)
    .replace(/\\/g, '\\\u200b') // a lone backslash is an escape lead-in — defuse it
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, '\\N');

function assHeader(theme, W, H) {
  /**
   * One V4+ style row.
   *
   * The field that trips everyone up is `OutlineColour`: with BorderStyle 3 it
   * is not an outline at all, it is the FILL of the opaque box behind the text,
   * and `BackColour` becomes the drop shadow. Set the translucent black on
   * BackColour — the intuitive-looking choice — and the caption renders as bare
   * white text over the UI, which is unreadable on a light panel.
   */
  const style = (name, size, colour, opts = {}) => {
    const borderStyle = opts.borderStyle ?? 3;
    return [
      `Style: ${name}`,
      theme.font, // Fontname
      size, // Fontsize
      colour, // PrimaryColour
      colour, // SecondaryColour
      borderStyle === 3 ? (opts.box ?? assColor('000000', '8C')) : assColor('000000', '40'), // OutlineColour
      opts.shadowColour ?? assColor('000000', '60'), // BackColour → shadow
      opts.bold ?? 0, // Bold
      0,
      0,
      0, // Italic, Underline, StrikeOut
      100,
      100, // ScaleX, ScaleY
      opts.spacing ?? 0, // Spacing
      0, // Angle
      borderStyle, // BorderStyle: 3 = opaque box hugging the text
      opts.outline ?? 14, // Outline — with BorderStyle 3 this is the box padding
      opts.shadow ?? 0, // Shadow
      5, // Alignment (5 = centred; every line positions itself with \pos)
      0,
      0,
      0, // Margins
      1, // Encoding
    ].join(',');
  };

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // The lower-third caption: the sentence the viewer reads.
    style('Caption', theme.captionSize, assColor('FFFFFF'), { box: assColor('05050A', '26') }),
    // The eyebrow above it: which part of the product this is.
    style('Kicker', theme.kickerSize, assColor(theme.accent), {
      box: assColor('05050A', '1A'),
      outline: 9,
      spacing: 2.4,
      bold: -1,
    }),
    // Title/chapter cards draw their own background, so no box here — just a
    // soft shadow so the headline lifts off the gradient.
    style('Title', theme.titleSize, assColor('FFFFFF'), {
      borderStyle: 1, outline: 0, shadow: 3, bold: -1,
    }),
    style('Subtitle', theme.subtitleSize, assColor('C9CBD8'), {
      borderStyle: 1, outline: 0, shadow: 2,
    }),
    style('Eyebrow', theme.kickerSize, assColor(theme.accent), {
      borderStyle: 1, outline: 0, shadow: 2, spacing: 3.5, bold: -1,
    }),
    // A pinned label beside a highlighted region.
    style('Callout', theme.kickerSize, assColor('FFFFFF'), {
      box: assColor(theme.accent.replace('#', ''), '3A'),
      outline: 10,
      bold: -1,
    }),
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ].join('\n');
}

/** One Dialogue line. `tags` are ASS override tags applied to the whole line. */
const assLine = (start, end, style, tags, text) =>
  `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${tags}${assText(text)}`;

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

if (manifestPath) {
  buildStoryboard(resolve(manifestPath), outName ?? 'braincue-demo');
  process.exit(0);
}

if (!clip) {
  console.error(
    'usage: node scripts/build-media.mjs <clip> [--fps 12] [--width 760] [--out name]\n' +
      '                                          [--caption "…"] [--hold 4] [--gif-only]\n' +
      '   or: node scripts/build-media.mjs --manifest <manifest.json> --out <name> [--music <file>]\n' +
      '   or: node scripts/build-media.mjs --check',
  );
  process.exit(2);
}

buildClip(clip, outName ?? clip.replace(/[\\/]/g, '-'));

/**
 * A single clip: one frame directory → one GIF (+ MP4).
 *
 * Used for the per-feature loops in the README and on the landing page, where a
 * GIF is the only thing that plays — github.com markdown will not autoplay
 * video, so the GIF is not a legacy format here, it is the delivery format.
 */
function buildClip(name, out) {
  const frameDir = resolve(MEDIA, 'frames', name);
  if (!existsSync(frameDir)) {
    console.error(
      `No frames at ${frameDir}\nCapture them first:\n  E2E_CAPTURE=1 npx playwright test e2e/media.capture.spec.ts`,
    );
    process.exit(1);
  }
  const allFrames = readdirSync(frameDir).filter(isFrame).sort();
  if (!allFrames.length) {
    console.error(`${frameDir} has no PNG frames.`);
    process.exit(1);
  }

  mkdirSync(MEDIA, { recursive: true });
  const kept = dedupeRuns(frameDir, allFrames, holdFrames);
  const input = stageFrames(frameDir, kept);
  if (kept.length !== allFrames.length) {
    console.log(`  trimmed ${allFrames.length - kept.length} duplicate frame(s) (kept ${kept.length})`);
  }

  const scale = `scale=${width}:-2:flags=lanczos`;
  const palette = resolve(dirname(input), '_palette.png');
  console.log(`${name}: ${allFrames.length} frames → ${fps} fps, ${width}px wide`);

  // An optional one-line label, burned in the same way the storyboard does it,
  // so a feature GIF lifted out of the video keeps its sentence.
  const caption = flag('caption', null);
  let sub = '';
  if (caption) {
    const font = pickFont();
    if (!font) {
      console.warn('  ! no system font found — building without the caption');
    } else {
      const H = Math.round((width * 800) / 1280);
      const theme = defaultTheme(font.family, width);
      const secs = kept.length / fps;
      const ass = resolve(dirname(input), '_caption.ass');
      writeFileSync(
        ass,
        `${assHeader(theme, width, H)}\n${assLine(
          0.15,
          Math.max(0.6, secs - 0.1),
          'Caption',
          `{\\an2\\pos(${Math.round(width / 2)},${H - 26})\\fad(250,250)}`,
          caption,
        )}\n`,
        'utf8',
      );
      sub = `,subtitles=${fesc(ass)}:fontsdir=${fesc(dirname(font.file))}`;
    }
  }

  ff(['-y', '-framerate', String(fps), '-i', input, '-vf', `fps=${fps},${scale}${sub},palettegen=stats_mode=diff`, palette]);
  ff([
    '-y', '-framerate', String(fps), '-i', input, '-i', palette,
    '-lavfi', `fps=${fps},${scale}${sub}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    resolve(MEDIA, `${out}.gif`),
  ]);
  rmSync(palette, { force: true });
  console.log(`  ✓ docs/media/${out}.gif`);

  if (!gifOnly) {
    ff([
      '-y', '-framerate', String(fps), '-i', input,
      // yuv420p + even dimensions: required for QuickTime/Safari playback.
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
      '-vf', `fps=${fps},${scale}${sub}`,
      '-movflags', '+faststart',
      resolve(MEDIA, `${out}.mp4`),
    ]);
    console.log(`  ✓ docs/media/${out}.mp4`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The storyboard video
// ─────────────────────────────────────────────────────────────────────────────

function defaultTheme(fontFamily, W = 1280) {
  const k = W / 1280; // every size is authored against the 1280-wide canvas
  return {
    font: fontFamily,
    /** The letterbox behind a scaled frame. Near-black, so the app is the
     *  brightest thing on screen — this is the only surface that should be. */
    bg: '#08080C',
    accent: '#A9B4FF',
    /** Card backgrounds. The app is dark, so the cards are where the film gets
     *  its colour and its lift; a card that is also near-black turns the whole
     *  thing into two and a half minutes of grey. */
    cardFrom: '#1B1550',
    cardTo: '#4B37C8',
    chapterFrom: '#141038',
    chapterTo: '#33279C',
    captionSize: Math.round(31 * k),
    kickerSize: Math.round(19 * k),
    titleSize: Math.round(60 * k),
    subtitleSize: Math.round(26 * k),
  };
}

/**
 * Accept both manifest shapes.
 *
 * v1 scenes were `{dir, caption, holdSec|fps, tailHoldSec}`. Keeping them
 * readable means an old capture on disk still assembles — the alternative is a
 * cryptic failure months later when someone re-runs the build without
 * re-capturing.
 */
function normalizeScene(scene) {
  if (scene.type) return scene;
  return {
    type: scene.fps ? 'motion' : 'still',
    dir: scene.dir,
    fps: scene.fps,
    durationSec: scene.holdSec ?? 3,
    tailHoldSec: scene.tailHoldSec,
    caption: scene.caption,
  };
}

function buildStoryboard(path, out) {
  const caps = ffCapabilities();
  if (!caps) {
    console.error('ffmpeg not found on PATH.');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(path);
  const W = manifest.width ?? 1280;
  const H = manifest.height ?? 800;
  const FPS = manifest.fps ?? 30;
  const font = pickFont();
  if (!font) {
    console.error('No system font found — captions are not optional in the demo video.');
    process.exit(1);
  }
  const theme = { ...defaultTheme(font.family, W), ...(manifest.theme ?? {}) };
  const scenes = manifest.scenes.map(normalizeScene);
  if (!scenes.length) {
    console.error(`${path} lists no scenes.`);
    process.exit(1);
  }

  const segDir = resolve(base, '_segments');
  rmSync(segDir, { recursive: true, force: true });
  mkdirSync(segDir, { recursive: true });

  // Every segment lands on the same canvas at the same rate, because xfade
  // refuses to blend streams that disagree about either.
  const canvas =
    `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${theme.bg}`;

  const built = [];
  scenes.forEach((scene, idx) => {
    const seg = resolve(segDir, `${String(idx).padStart(2, '0')}.mp4`);
    const duration =
      scene.type === 'motion'
        ? buildMotionSegment(scene, base, seg, { W, H, FPS, canvas, theme })
        : scene.type === 'asset'
          ? buildAssetSegment(scene, seg, { W, H, FPS, canvas, theme })
          : scene.type === 'title' || scene.type === 'chapter'
            ? buildCardSegment(scene, seg, { W, H, FPS, theme, caps })
            : buildStillSegment(scene, base, seg, { W, H, FPS, canvas, theme });
    built.push({ scene, seg, duration });
    console.log(`  segment ${String(idx).padStart(2, '0')} ${scene.type.padEnd(7)} ${duration.toFixed(2)}s  ${scene.dir ?? scene.title ?? ''}`);
  });

  // ── Cross-fade the segments into one stream ───────────────────────────────
  //
  // xfade offsets accumulate: each transition eats `t` seconds of BOTH the
  // outgoing and incoming segment, so the running total is
  //   acc = acc + d(i) - t(i)
  // and scene i starts fading in at the offset computed before it is added.
  // Those same numbers drive the subtitle timings below — one source of truth
  // for pacing, so retuning a hold can never desync its caption.
  const starts = [0];
  const offsets = [0];
  let acc = built[0].duration;
  for (let i = 1; i < built.length; i++) {
    const t = transitionSec(built[i].scene, caps);
    const offset = acc - t;
    offsets.push(offset);
    starts.push(offset);
    acc = acc + built[i].duration - t;
  }
  const total = acc;

  const inputs = built.flatMap((b) => ['-i', b.seg]);
  let graph = '';
  let last = '[0:v]';
  for (let i = 1; i < built.length; i++) {
    const t = transitionSec(built[i].scene, caps);
    const nextLabel = i === built.length - 1 ? '[xf]' : `[x${i}]`;
    if (t <= 0) {
      // A hard cut still has to go through xfade to keep one linear chain;
      // `fade` with a 1-frame duration is the cheapest way to express that.
      graph += `${last}[${i}:v]xfade=transition=fade:duration=${(1 / FPS).toFixed(4)}:offset=${offsets[i].toFixed(4)}${nextLabel};`;
    } else {
      const kind = built[i].scene.transition ?? 'fade';
      graph += `${last}[${i}:v]xfade=transition=${kind}:duration=${t.toFixed(3)}:offset=${offsets[i].toFixed(4)}${nextLabel};`;
    }
    last = nextLabel;
  }
  if (built.length === 1) graph = '[0:v]null[xf];';

  // ── One subtitle pass over the finished cut ───────────────────────────────
  const ass = resolve(segDir, 'captions.ass');
  writeFileSync(ass, buildAss(built, starts, total, { W, H, theme, caps }), 'utf8');

  // Open from black and close to black — the two cheapest edits that make a
  // cut read as a film rather than a screen recording that happened to start.
  let chain =
    `[xf]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.7).toFixed(3)}:d=0.7` +
    `,subtitles=${fesc(ass)}:fontsdir=${fesc(dirname(font.file))}`;

  // A hairline progress bar: at 3 minutes a viewer wants to know how much is
  // left, and every second spent wondering is a second not spent watching.
  if (caps.drawbox) {
    chain +=
      `,drawbox=x=0:y=${H - 3}:w='${W}*t/${total.toFixed(3)}':h=3:color=${theme.accent}@0.9:t=fill`;
  }
  chain += ',format=yuv420p[v]';

  const music = flag('music', null);
  const outPath = resolve(MEDIA, `${out}.mp4`);
  const args = ['-y', ...inputs];
  if (music) args.push('-i', resolve(music));

  args.push('-filter_complex', graph + chain, '-map', '[v]');
  if (music) {
    // Duck it well under any voiceover added later, and never let the track
    // decide the length of the video.
    args.push(
      '-filter_complex',
      `[${built.length}:a]volume=0.18,afade=t=in:st=0:d=1.5,afade=t=out:st=${(total - 2).toFixed(3)}:d=2[a]`,
    );
    args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  } else {
    args.push('-an');
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-movflags', '+faststart',
    outPath,
  );

  // Two -filter_complex flags is one too many for ffmpeg; merge when scoring.
  if (music) {
    const i = args.indexOf('-filter_complex');
    const j = args.lastIndexOf('-filter_complex');
    args[i + 1] = `${args[i + 1]};${args[j + 1]}`;
    args.splice(j, 2);
  }

  ff(args, { label: 'ffmpeg (assemble)' });
  console.log(`  ✓ docs/media/${out}.mp4  —  ${fmtDuration(total)}, ${built.length} scenes`);
}

// A declaration, not a `const` arrow: the entry points above call into this
// file at module top level, before a `const` further down has initialised.
function fmtDuration(s) {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** How long scene i's incoming transition runs. A `cut` is exactly that. */
function transitionSec(scene, caps) {
  if (!caps.xfade) return 0;
  if (scene.transition === 'cut') return 0;
  return scene.transitionSec ?? 0.5;
}

/**
 * A still: one frame, held.
 *
 * Deliberately held, not drifted. This used to apply a slow Ken Burns push on
 * the theory that a completely static frame reads as a stall — but `zoompan`
 * steps in whole pixels, so at the speed that would be tasteful the image
 * visibly crawls, and text is the worst possible subject for it. There is no
 * setting that fixes that; the effect was simply making the film worse.
 *
 * The movement in this cut comes from the cross-fades between scenes, the four
 * genuinely streamed scenes, and the cards — none of which have to fight the
 * pixel grid.
 */
function buildStillSegment(scene, base, out, { W, H, FPS, canvas, theme }) {
  const dir = resolve(base, scene.dir);
  const files = existsSync(dir) ? readdirSync(dir).filter(isFrame).sort() : [];
  if (!files.length) {
    console.error(`scene ${scene.dir}: no frames`);
    process.exit(1);
  }
  const duration = scene.durationSec ?? 3.5;
  // The LAST frame is the settled state — earlier ones can still be mid-render.
  const frame = resolve(dir, files[files.length - 1]);

  const filters = [`${canvas},fps=${FPS}`, calloutFilter(scene, theme), 'format=yuv420p']
    .filter(Boolean)
    .join(',');

  ff([
    '-y', '-loop', '1', '-framerate', String(FPS), '-t', String(duration), '-i', frame,
    '-vf', filters,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    out,
  ], { label: `ffmpeg (still ${scene.dir})` });
  return duration;
}

/** A motion scene: the real frame sequence, optionally frozen on its payoff. */
function buildMotionSegment(scene, base, out, { W, H, FPS, canvas, theme }) {
  const dir = resolve(base, scene.dir);
  const files = existsSync(dir) ? readdirSync(dir).filter(isFrame).sort() : [];
  if (!files.length) {
    console.error(`scene ${scene.dir}: no frames`);
    process.exit(1);
  }
  const kept = dedupeRuns(dir, files, scene.hold ?? holdFrames);
  const input = stageFrames(dir, kept);
  const tail = scene.tailHoldSec ?? 0;

  /**
   * Keep a long stream from eating the film.
   *
   * How long an answer takes is up to the model: the same scene captured twice
   * came back as 24 frames once and 260 the next time. At the authored rate that
   * is a 26-second scene — one sixth of the whole film spent watching one answer
   * arrive, which is both boring and out of proportion to what it proves.
   *
   * So the authored `fps` is a floor, not a fixed rate: a stream longer than
   * `maxSec` is played back faster to fit. Every frame is still shown, in order,
   * with nothing cut from the middle — the only thing that changes is the speed,
   * which is the one distortion a viewer reads correctly without being told.
   */
  const authoredFps = scene.fps ?? 12;
  const maxSec = scene.maxSec ?? 9;
  const sourceFps = Math.max(authoredFps, kept.length / maxSec);
  if (sourceFps > authoredFps) {
    console.log(
      `    ${scene.dir}: ${kept.length} frames would run ${(kept.length / authoredFps).toFixed(1)}s` +
        ` — played at ${sourceFps.toFixed(1)} fps to fit ${maxSec}s`,
    );
  }
  const filters = [
    canvas,
    tail ? `tpad=stop_mode=clone:stop_duration=${tail}` : null,
    calloutFilter(scene, theme),
    `fps=${FPS}`,
    'format=yuv420p',
  ]
    .filter(Boolean)
    .join(',');

  ff([
    '-y', '-framerate', String(sourceFps), '-i', input,
    '-vf', filters,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    out,
  ], { label: `ffmpeg (motion ${scene.dir})` });

  return kept.length / sourceFps + tail;
}

/**
 * A ready-made asset dropped into the cut — a GIF or MP4 from `docs/media/`.
 *
 * The explainer loops (`stealth-split.gif` and friends) are the one thing in
 * this pipeline that is DRAWN rather than recorded: they illustrate a claim
 * about what the app does, which is a different job from showing the app doing
 * it. Screenshots must never be illustrations; diagrams must never pretend to be
 * screenshots. Both rules hold as long as the two stay visibly different, which
 * is why these have their own look.
 *
 * They carry their own titles, so a scene using one usually wants no caption.
 */
function buildAssetSegment(scene, out, { W, H, FPS, canvas, theme }) {
  const src = resolve(MEDIA, scene.src);
  if (!existsSync(src)) {
    console.error(`scene asset ${scene.src}: not found at ${src}`);
    process.exit(1);
  }
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src],
    { encoding: 'utf8' },
  );
  const natural = Number((probe.stdout || '').trim()) || 6;
  const duration = scene.durationSec ?? natural;
  const tail = scene.tailHoldSec ?? 0;

  const args = ['-y'];
  // Loop a short asset rather than freezing it: these are designed to cycle.
  if (duration > natural + 0.05) args.push('-stream_loop', '-1');
  args.push(
    '-i', src,
    '-t', String(duration),
    '-vf',
    [canvas, tail ? `tpad=stop_mode=clone:stop_duration=${tail}` : null, `fps=${FPS}`, 'format=yuv420p']
      .filter(Boolean)
      .join(','),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    out,
  );
  ff(args, { label: `ffmpeg (asset ${scene.src})` });
  return duration + tail;
}

/**
 * A title or chapter card — generated, not captured.
 *
 * The background is a slow animated gradient rather than flat black: the eye
 * reads a static colour field as a stall, and this is exactly where a viewer
 * decides whether to keep watching.
 */
function buildCardSegment(scene, out, { W, H, FPS, theme, caps }) {
  const duration = scene.durationSec ?? (scene.type === 'chapter' ? 2.4 : 4);
  const chapter = scene.type === 'chapter';
  const [c0, c1] = chapter
    ? [theme.chapterFrom, theme.chapterTo]
    : [theme.cardFrom, theme.cardTo];
  // A radial gradient drifting slowly, rather than a flat fill: the eye reads a
  // static colour field as a stall, and a card is exactly where a viewer decides
  // whether to keep watching. The bright end sits off-centre so the light
  // appears to come from somewhere.
  const source = caps.gradients
    ? [
        '-f', 'lavfi', '-i',
        `gradients=s=${W}x${H}:c0=${c1}:c1=${c0}:x0=${Math.round(W * 0.32)}:y0=${Math.round(H * 0.28)}:x1=${W}:y1=${H}:d=${duration}:speed=0.02:type=radial`,
      ]
    : ['-f', 'lavfi', '-i', `color=c=${c0}:s=${W}x${H}:d=${duration}`];

  const args = ['-y', ...source, '-t', String(duration)];
  const logo = resolve(ROOT, 'resources/icon.png');
  if (scene.logo && existsSync(logo)) {
    // The mark sits above the headline on the opening card only — a logo on
    // every card is a slide deck, not a film.
    args.push('-i', logo);
    // High enough to clear the eyebrow, which the ASS pass puts at 0.37·H.
    args.push(
      '-filter_complex',
      `[1:v]scale=${Math.round(W * 0.062)}:-1[logo];[0:v][logo]overlay=x=(W-w)/2:y=${Math.round(H * 0.2)}:format=auto,fps=${FPS},format=yuv420p[v]`,
      '-map', '[v]',
    );
  } else {
    args.push('-vf', `fps=${FPS},format=yuv420p`);
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), out);
  ff(args, { label: `ffmpeg (card ${scene.title ?? ''})` });
  return duration;
}

/**
 * Draw attention to one region of the frame.
 *
 * The rectangle comes from the capture spec, which measures the real element
 * with `boundingBox()` — so a callout cannot end up pointing at whitespace
 * after a layout change, the way a hand-typed coordinate silently would.
 */
function calloutFilter(scene, theme) {
  const c = scene.callout;
  if (!c) return null;
  const { x, y, w, h } = c;
  return `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:color=${theme.accent}@0.95:t=3`;
}

/** Every caption, kicker, title and callout label, timed against the final cut. */
function buildAss(built, starts, total, { W, H, theme, caps }) {
  const lines = [assHeader(theme, W, H)];
  const cx = Math.round(W / 2);

  built.forEach((b, i) => {
    const { scene } = b;
    const t = transitionSec(scene, caps);
    // Hold the text inside the scene's own screen time, clear of both fades:
    // a caption that starts during the incoming cross-fade reads as a ghost.
    const from = starts[i] + t + 0.12;
    const until = (i + 1 < built.length ? starts[i + 1] : total) - 0.12;
    if (until <= from) return;

    if (scene.type === 'title' || scene.type === 'chapter') {
      const mid = Math.round(H / 2);
      if (scene.eyebrow) {
        lines.push(
          assLine(from, until, 'Eyebrow', `{\\an5\\pos(${cx},${mid - Math.round(H * 0.13)})\\fad(320,260)}`, scene.eyebrow.toUpperCase()),
        );
      }
      if (scene.title) {
        // A short rise into place: 24px of travel is enough to register as
        // motion and small enough not to look like a PowerPoint entrance.
        lines.push(
          assLine(from, until, 'Title', `{\\an5\\move(${cx},${mid + 24},${cx},${mid},0,420)\\fad(360,300)}`, scene.title),
        );
      }
      if (scene.subtitle) {
        lines.push(
          assLine(from + 0.25, until, 'Subtitle', `{\\an5\\pos(${cx},${mid + Math.round(H * 0.115)})\\fad(400,300)}`, scene.subtitle),
        );
      }
      return;
    }

    // 130px up, not 104: the caption's box extends ~64px above its own anchor,
    // so a kicker any lower sits inside it.
    if (scene.kicker) {
      lines.push(
        assLine(from, until, 'Kicker', `{\\an5\\pos(${cx},${H - 130})\\fad(260,220)}`, scene.kicker.toUpperCase()),
      );
    }
    if (scene.caption) {
      lines.push(
        assLine(from + (scene.kicker ? 0.12 : 0), until, 'Caption', `{\\an2\\pos(${cx},${H - 44})\\fad(300,240)}`, scene.caption),
      );
    }
    if (scene.callout?.label) {
      const c = scene.callout;
      /**
       * Beside a small target, above or below a wide one.
       *
       * Always stacking the label vertically puts it on top of whatever the UI
       * has directly above the highlight — and next to a button there is almost
       * never room, because a button sits in a row of text. A narrow target has
       * the opposite problem and the opposite solution: plenty of horizontal
       * space, so the label goes in the margin beside it and points at the box
       * without covering anything.
       */
      const cy = Math.round(c.y + c.h / 2);
      const gap = 18;
      let tags;
      if (c.w < W * 0.35 && c.x + c.w + gap < W * 0.82) {
        tags = `{\\an1\\pos(${Math.round(c.x + c.w + gap)},${cy + 12})\\fad(280,220)}`; // to the right
      } else if (c.w < W * 0.35 && c.x - gap > W * 0.18) {
        tags = `{\\an3\\pos(${Math.round(c.x - gap)},${cy + 12})\\fad(280,220)}`; // to the left
      } else {
        const above = c.y > 70;
        tags = `{\\an5\\pos(${Math.round(c.x + c.w / 2)},${Math.round(above ? c.y - 28 : c.y + c.h + 28)})\\fad(280,220)}`;
      }
      lines.push(assLine(from + 0.2, until, 'Callout', tags, c.label));
    }
  });

  return `${lines.join('\n')}\n`;
}
