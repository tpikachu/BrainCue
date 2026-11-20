import type React from 'react';

/** The Cue Card's compact icon button (header + answer-controls rows). */
export function Btn(props: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'default' | 'warn' | 'danger';
  title?: string;
  expanded?: boolean;
  controls?: string;
  pressed?: boolean;
}) {
  const base =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400';
  const tone =
    props.tone === 'warn'
      ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
      : props.tone === 'danger'
        ? 'text-red-400 hover:bg-red-500/20 hover:text-red-300'
        : props.active
          ? 'bg-white/10 text-white'
          : 'text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100';
  return (
    <button
      title={props.title}
      aria-label={props.title}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={`${base} ${tone}`}
    >
      {props.children}
    </button>
  );
}
