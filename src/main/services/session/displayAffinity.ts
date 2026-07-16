import type { BrowserWindow } from 'electron';
import { log } from '../security/logger';

/** `SetWindowDisplayAffinity` values (WinUser.h). `WDA_EXCLUDEFROMCAPTURE` is
 *  what `setContentProtection(true)` sets — the window is invisible to screen
 *  capture (Zoom/Meet/Teams, recorders). `WDA_NONE` means capturable. */
export const WDA_NONE = 0x0;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;

type AffinityReader = (win: BrowserWindow) => number | null;

/**
 * Bind `user32!GetWindowDisplayAffinity` via koffi (N-API — no rebuild needed
 * for Electron). This is the ground-truth oracle for Privacy Mode: Electron has
 * no getter for content protection, and the OS wipes the affinity behind our
 * back (e.g. when our own loopback capture starts), so the only faithful way to
 * know a window's REAL capture-exclusion state is to ask the OS. Reading is a
 * plain user32 query with no side effects — unlike re-CALLING
 * setContentProtection, which composites a fresh frame and can flash in an
 * active WGC capture. That asymmetry (reads are free, writes flash) is why the
 * protection observer in privacy.ts polls this instead of blindly re-asserting.
 */
function bindReader(): AffinityReader | null {
  if (process.platform !== 'win32') return null;
  try {
    // Runtime require: koffi is a native module — keep its load failure
    // survivable (privacy degrades to set-once instead of crashing the app).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const getAffinity = user32.func('__stdcall', 'GetWindowDisplayAffinity', 'bool', [
      process.arch === 'ia32' ? 'uint32' : 'uint64',
      'void *',
    ]);
    const out = Buffer.alloc(4);
    return (win: BrowserWindow): number | null => {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      if (hwnd === 0n) return null;
      if (!getAffinity(process.arch === 'ia32' ? Number(hwnd) : hwnd, out)) return null;
      return out.readUInt32LE(0);
    };
  } catch (e) {
    log.warn('display-affinity reader unavailable (koffi failed to load)', e);
    return null;
  }
}

let reader: AffinityReader | null | undefined;

/** Whether the ground-truth affinity oracle is available on this machine. */
export function affinityReadable(): boolean {
  if (reader === undefined) reader = bindReader();
  return reader !== null;
}

/** The window's REAL, OS-level display affinity right now (0x11 = excluded from
 *  capture, 0x0 = visible to capture), or null when unreadable (non-Windows,
 *  koffi missing, or the window has no valid HWND). */
export function readWindowAffinity(win: BrowserWindow): number | null {
  if (reader === undefined) reader = bindReader();
  if (!reader || win.isDestroyed()) return null;
  try {
    return reader(win);
  } catch {
    return null;
  }
}
