import { EventEmitter } from 'node:events';

/** Lightweight main-process event bus for cross-module signals that should NOT
 *  cross the IPC bridge (e.g. telling the tray menu to refresh when Privacy Mode
 *  changes). Renderer-facing events still go through `broadcast` / EVENTS. */
class AppEvents extends EventEmitter {}

export const appEvents = new AppEvents();

export const APP_EVENT = {
  privacyChanged: 'privacy-changed',
  overlayVisibility: 'overlay-visibility',
} as const;
