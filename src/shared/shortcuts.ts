// Single source of truth for the app's global shortcuts. Used by the main
// process (to register them with Electron's globalShortcut) and the renderer
// (Settings UI to display/edit them). Accelerators use Electron's format:
// https://www.electronjs.org/docs/latest/api/accelerator

export type ShortcutAction =
  | 'overlay:toggle'
  | 'capture:quick'
  | 'capture:region'
  | 'session:toggle-pause'
  | 'privacy:toggle'
  | 'overlay:toggle-clickthrough';

export interface ShortcutDef {
  id: ShortcutAction;
  label: string;
  description: string;
  default: string; // Electron accelerator
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    id: 'overlay:toggle',
    label: 'Show / hide overlay',
    description: 'Toggle the floating answer overlay.',
    default: 'CommandOrControl+Shift+Space',
  },
  {
    id: 'capture:quick',
    label: 'Quick solve (clipboard)',
    description: 'Answer the problem text you copied to the clipboard.',
    // Was Ctrl+Shift+Enter, which collides with NVIDIA's 3D-viewer hotkey.
    default: 'CommandOrControl+Shift+A',
  },
  {
    id: 'capture:region',
    label: 'Select region to solve',
    description: 'Drag-select a screen area to read and answer.',
    default: 'CommandOrControl+Shift+S',
  },
  {
    id: 'session:toggle-pause',
    label: 'Pause / resume AI',
    description: 'Pause or resume the live assistant.',
    default: 'CommandOrControl+Shift+P',
  },
  {
    id: 'privacy:toggle',
    label: 'Toggle Privacy Mode',
    description: 'Hide or reveal the app from screen sharing and recording.',
    default: 'CommandOrControl+Shift+H',
  },
  {
    id: 'overlay:toggle-clickthrough',
    label: 'Overlay click-through',
    description: 'Let the mouse pass through the overlay.',
    default: 'CommandOrControl+Shift+\\',
  },
];

export const SHORTCUT_DEFAULTS: Record<ShortcutAction, string> = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.id, d.default]),
) as Record<ShortcutAction, string>;
