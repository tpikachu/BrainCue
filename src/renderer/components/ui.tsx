import type React from 'react';
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from './icons';

/* Small shared UI kit so pages look consistent. Tailwind-only, no deps. */

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-neutral-500 border-t-transparent ${className}`}
    />
  );
}

export function Button({
  variant = 'default',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'ghost' | 'danger' | 'success';
  loading?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-900/40',
    success: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-900/40',
    danger: 'bg-red-600/90 hover:bg-red-600 text-white',
    default: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 ring-1 ring-white/5',
    ghost: 'bg-transparent hover:bg-neutral-800/70 text-neutral-300',
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Card({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/5 bg-neutral-900/70 p-5 shadow-lg shadow-black/20 ${className}`}
    >
      {children}
    </section>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'green' | 'amber' | 'blue';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-800 text-neutral-300',
    green: 'bg-green-900/40 text-green-300',
    amber: 'bg-amber-900/40 text-amber-300',
    blue: 'bg-blue-900/40 text-blue-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

const inputBase =
  'w-full rounded-lg border border-neutral-700/80 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputBase} resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

/** Text input with a leading search icon — for filter/search boxes. */
export function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      <input {...props} className={`${inputBase} pl-9 ${props.className ?? ''}`} />
    </div>
  );
}

/** Page with a FIXED header (title/subtitle/actions) and an independently
 *  scrolling body, so the header stays put while content scrolls. */
export function Page({
  title,
  subtitle,
  actions,
  width = 'max-w-3xl',
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-white/5 bg-neutral-950/70 px-8 py-5 backdrop-blur">
        <div className={`mx-auto flex w-full items-start justify-between gap-4 ${width}`}>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
      </header>
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className={`mx-auto w-full ${width}`}>{children}</div>
      </div>
    </div>
  );
}

/** Simple prev/next pager. Hidden when there's a single page. */
export function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-3 text-sm text-neutral-400">
      <Button variant="ghost" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        <ChevronLeftIcon /> Prev
      </Button>
      <span>
        {page + 1} / {totalPages}
      </span>
      <Button variant="ghost" disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)}>
        Next <ChevronRightIcon />
      </Button>
    </div>
  );
}

/** A clear on/off switch with an explicit label, so state is unambiguous. */
export function Switch({
  checked,
  onChange,
  onLabel = 'On',
  offLabel = 'Off',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5"
    >
      <span
        className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors duration-200 ${
          checked ? 'bg-green-500' : 'bg-neutral-600'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
      <span className={`text-sm font-medium ${checked ? 'text-green-400' : 'text-neutral-400'}`}>
        {checked ? onLabel : offLabel}
      </span>
    </button>
  );
}

/** Full-area blocking overlay shown during long operations (e.g. parsing). */
export function BusyOverlay({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 px-8 py-6 shadow-2xl">
        <Spinner className="h-8 w-8" />
        <p className="text-sm text-neutral-200">{message}</p>
      </div>
    </div>
  );
}
