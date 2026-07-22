import type React from 'react';

/** Opt an element out of the window drag region (the header is draggable). */
export const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

/** Shared look for the small inline control dropdown buttons. */
export const ctrlSelect =
  'rounded-md border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-[11px] normal-case text-neutral-200 outline-none';
