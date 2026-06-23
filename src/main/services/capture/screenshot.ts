import { desktopCapturer, screen, type Display } from 'electron';
import { log } from '../security/logger';

export interface CaptureResult {
  /** Screenshot of the requested display as a PNG data URL (resolution-capped). */
  dataUrl: string;
  width: number;
  height: number;
}

// Cap the captured width. Full native resolution (e.g. 4K @ 150% scale) produces
// a huge image whose data URL chokes IPC/canvas and can freeze the app. This is
// plenty for vision reading and region cropping.
const MAX_WIDTH = 1920;

/** Capture a specific display (defaults to the primary one). On multi-monitor
 *  setups the source is matched by display id so we grab the right screen. */
export async function captureScreen(display?: Display): Promise<CaptureResult> {
  const target = display ?? screen.getPrimaryDisplay();
  const { width, height } = target.size; // CSS pixels
  const aspect = height / width;
  const targetWidth = Math.min(width, MAX_WIDTH);
  const targetHeight = Math.round(targetWidth * aspect);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
  });
  // Match the source to the requested display; fall back to the first screen.
  const source = sources.find((s) => s.display_id === String(target.id)) ?? sources[0];
  if (!source) throw new Error('No screen source available for capture.');

  const size = source.thumbnail.getSize();
  const empty = source.thumbnail.isEmpty();
  // Diagnostics: a blank region selector almost always traces back to here —
  // log what the OS gave us so it's clear whether capture worked. A cheap
  // average-brightness sample distinguishes a real image from an all-black one.
  let brightness = -1;
  if (!empty) {
    const bmp = source.thumbnail.toBitmap();
    let sum = 0,
      n = 0;
    for (let i = 0; i < bmp.length; i += 4 * 97) {
      sum += bmp[i] + bmp[i + 1] + bmp[i + 2];
      n++;
    }
    brightness = n ? Math.round(sum / (n * 3)) : -1;
  }
  log.info(
    `capture: ${sources.length} source(s), chose display_id=${source.display_id || '(none)'}, ` +
      `thumb=${size.width}x${size.height}, empty=${empty}, avgBrightness=${brightness}`,
  );
  if (empty || size.width === 0 || size.height === 0) {
    throw new Error('Captured screen image was empty — likely a GPU/driver screen-capture issue.');
  }

  return { dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height };
}
