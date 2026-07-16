import type React from 'react';
import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, SearchIcon } from './icons';

/** Centered modal dialog. Closes on overlay click or Escape. */
export function Modal({
  open,
  onClose,
  title,
  width = 'max-w-2xl',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read onClose through a ref so the focus effect depends ONLY on `open`. Call sites
  // pass a new inline onClose each render; if it were a dep, any parent re-render with
  // the modal open (e.g. the Cue Card's per-frame audio-meter updates) would re-run
  // this effect and yank focus out of the dialog's controls.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog (so keyboard/AT users land inside it) and restore it
    // to whatever was focused before, on close. `prev` is captured once, when open→true.
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`my-8 w-full ${width} rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl shadow-black/40 outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <h3 className="font-medium">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-200"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

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
  tone?: 'neutral' | 'green' | 'amber' | 'blue' | 'red';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-800 text-neutral-300',
    green: 'bg-green-900/40 text-green-300',
    amber: 'bg-amber-900/40 text-amber-300',
    blue: 'bg-blue-900/40 text-blue-300',
    red: 'bg-red-900/40 text-red-300',
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

/** In-window replacement for a native `<select>`. A native select's option list
 *  opens as a SEPARATE OS popup window that does NOT inherit the app window's
 *  screen-capture exclusion — with Privacy Mode on, the dropdown list is still
 *  visible to screen shares (verified against WGC capture: the popup window
 *  reads display affinity 0, i.e. unprotected). This popover renders inside the
 *  window's own DOM, so it is hidden together with the window. Use it for any
 *  dropdown that can be open while the user is sharing their screen. */
export function Dropdown({
  value,
  options,
  onChange,
  buttonClassName = 'flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500',
  className = '',
  disabled = false,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  buttonClassName?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Swallow the Escape so an enclosing Modal (which listens on `window`)
        // doesn't close along with the dropdown.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={buttonClassName}
        onClick={(e) => {
          // When this Dropdown stands in for a <select> inside a <label> (e.g.
          // dashboard Field), the label would re-dispatch a synthetic click onto
          // this button and toggle it a second time (open→closed). Cancel both so
          // one physical click = one toggle.
          e.preventDefault();
          e.stopPropagation();
          if (!open && rootRef.current) {
            // Open upward when the list would run past the window bottom and
            // there is more room above (the Cue Card is small).
            const r = rootRef.current.getBoundingClientRect();
            const room = 240;
            setOpenUp(r.bottom + room > window.innerHeight && r.top > window.innerHeight - r.bottom);
          }
          setOpen((v) => !v);
        }}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden>
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.4a.75.75 0 0 1-1.08 0l-4.25-4.4a.75.75 0 0 1 .02-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className={`absolute left-0 z-[60] max-h-56 w-full min-w-max overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50 ${
            openUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={`block w-full px-3 py-1.5 text-left text-sm transition-colors ${
                  o.value === value
                    ? 'bg-indigo-600/25 text-indigo-200'
                    : 'text-neutral-200 hover:bg-neutral-800'
                }`}
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Flatten an <option>'s children (strings, numbers, fragments) to plain text. */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/**
 * A drop-in for a native `<select>` that renders the in-window {@link Dropdown}
 * instead — a native select's option list opens as a SEPARATE OS popup window
 * that is NOT covered by the app's screen-capture exclusion, so it shows in
 * Zoom/Meet even with Privacy Mode on. Keeps the native-select call shape
 * (`value` + `<option>` children + an event-style `onChange`) so existing call
 * sites need no changes.
 */
export function Select({
  value,
  onChange,
  disabled,
  className,
  children,
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const options: { value: string; label: string }[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== 'option') return;
    const p = child.props as { value?: string | number; children?: React.ReactNode };
    options.push({ value: String(p.value ?? ''), label: nodeText(p.children) });
  });
  return (
    <Dropdown
      value={String(value ?? '')}
      options={options}
      disabled={disabled}
      className={className ?? ''}
      buttonClassName={`${inputBase} flex items-center justify-between gap-2 text-left`}
      onChange={(v) =>
        onChange?.({
          target: { value: v },
          currentTarget: { value: v },
        } as unknown as React.ChangeEvent<HTMLSelectElement>)
      }
    />
  );
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
  width = 'max-w-4xl',
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
        <div className={`page-enter mx-auto w-full ${width}`}>{children}</div>
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
