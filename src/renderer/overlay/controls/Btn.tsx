import type React from 'react';

/** The Cue Card's compact icon button (header + answer-controls rows). */
export function Btn(props: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'default' | 'warn' | 'danger';
  title?: string;
}) {
  const base =
    'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 transition-colors';
  const tone =
    props.tone === 'warn'
      ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
      : props.tone === 'danger'
        ? 'text-red-400 hover:bg-red-500/20 hover:text-red-300'
        : props.active
          ? 'bg-neutral-700 text-white'
          : 'text-neutral-400 hover:bg-neutral-700/70 hover:text-neutral-200';
  return (
    <button
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      className={`${base} ${tone}`}
    >
      {props.children}
    </button>
  );
}
