import type React from 'react';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** Pretty-print an Electron accelerator for display (e.g. "Ctrl + Shift + A"). */
export function formatAccel(accel: string): string {
  const map: Record<string, string> = {
    CommandOrControl: IS_MAC ? '⌘' : 'Ctrl',
    Command: '⌘',
    Control: 'Ctrl',
    Alt: IS_MAC ? '⌥' : 'Alt',
    Option: '⌥',
    Shift: IS_MAC ? '⇧' : 'Shift',
    Super: 'Win',
  };
  return accel
    .split('+')
    .map((p) => map[p] ?? p)
    .join(' + ');
}

/** Convert a keydown into the key portion of an Electron accelerator, or null
 *  if only modifier keys are held (keep listening). */
export function keyFromEvent(e: React.KeyboardEvent): string | null {
  const k = e.key;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) return null;
  if (k === ' ') return 'Space';
  if (k.startsWith('Arrow')) return k.slice(5); // ArrowUp -> Up
  const named: Record<string, string> = {
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  if (named[k]) return named[k];
  if (/^F\d{1,2}$/.test(k)) return k; // function keys
  if (k.length === 1) return k.toUpperCase();
  return null;
}
