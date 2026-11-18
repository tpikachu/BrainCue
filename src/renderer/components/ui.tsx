import type React from 'react';
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, SearchIcon } from './icons';

/** Open modals, innermost last: only the top one answers Escape and keeps
 *  focus, so a confirm over a form never closes both. */
const modalStack: number[] = [];
let modalSeq = 0;

/** What a modal body can call to leave through the same guard as Escape /
 *  backdrop / × — its own Cancel button, say. */
const ModalDismissContext = createContext<(() => void) | null>(null);
/** Request this modal's close through its guard (busy / unsaved draft).
 *  Outside a Modal it is `fallback` (or nothing). */
export function useModalDismiss(fallback?: () => void): () => void {
  return useContext(ModalDismissContext) ?? fallback ?? (() => {});
}

/** A modal's own Cancel: leaves through the same guard as Escape. */
export function ModalCancel({ children = 'Cancel', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const dismiss = useModalDismiss();
  return (
    <Button variant="ghost" {...rest} onClick={dismiss}>
      {children}
    </Button>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/**
 * Centered modal dialog.
 *
 * - **Focus** moves into the dialog on open, stays there (Tab / Shift+Tab
 *   wrap inside it; focus that wanders out is brought back) and returns to
 *   whatever had it before, on close. It never re-runs on a re-render, so a
 *   parent's live updates do not pull focus out of a field.
 * - **Dismissal** (Escape, backdrop, ×, or a body button via
 *   {@link useModalDismiss}) goes through a guard: while `busy` it is
 *   refused, and said so — a save in flight is not silently dropped; with
 *   `dirty` (an edited draft) it asks "Discard your changes?" first. Escape
 *   closes an open inner control (a dropdown, the discard question) before
 *   the dialog.
 */
export function Modal({
  open,
  onClose,
  title,
  width = 'max-w-2xl',
  dirty = false,
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: string;
  /** An edited draft would be lost: ask before closing. */
  dirty?: boolean;
  /** Something is in flight (saving, parsing…): do not close. A string says what. */
  busy?: boolean | string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Read onClose (and the guard) through refs so the focus effect depends ONLY
  // on `open`. Call sites pass a new inline onClose each render; if it were a
  // dep, any parent re-render with the modal open (e.g. the Cue Card's
  // per-frame audio-meter updates) would re-run this effect and yank focus out
  // of the dialog's controls.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const guard = useRef({ dirty, busy });
  guard.current = { dirty, busy };
  const [ask, setAsk] = useState<null | 'discard' | 'busy'>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++modalSeq;

  const requestClose = useRef(() => {
    if (guard.current.busy) return setAsk('busy');
    if (guard.current.dirty) return setAsk('discard');
    onCloseRef.current();
  }).current;

  useEffect(() => {
    if (!open) setAsk(null);
  }, [open]);
  // The busy note clears itself once the work is done.
  useEffect(() => {
    if (!busy && ask === 'busy') setAsk(null);
  }, [busy, ask]);
  useEffect(() => {
    if (ask === 'discard') keepRef.current?.focus();
  }, [ask]);

  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    modalStack.push(id);
    const top = () => modalStack[modalStack.length - 1] === id;
    const onKey = (e: KeyboardEvent) => {
      if (!top()) return;
      if (e.key === 'Escape') {
        // An inner control (an open dropdown) handled it first.
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (askRef.current) setAsk(null);
        else requestClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const inside = !!at && dialogRef.current.contains(at);
      if (e.shiftKey && (at === first || at === dialogRef.current || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that leaves the dialog (a click on the page behind is caught by
    // the backdrop, but programmatic focus is not) is brought back.
    const onFocusIn = (e: FocusEvent) => {
      if (!top() || !dialogRef.current) return;
      if (!dialogRef.current.contains(e.target as Node)) dialogRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    // Move focus into the dialog (so keyboard/AT users land inside it) and restore it
    // to whatever was focused before, on close. `prev` is captured once, when open→true.
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      const at = modalStack.indexOf(id);
      if (at >= 0) modalStack.splice(at, 1);
      if (prev && prev.isConnected) prev.focus?.();
    };
  }, [open, requestClose]);

  if (!open) return null;
  const busyText = typeof busy === 'string' ? busy : 'Still working';
  return (
    <ModalDismissContext.Provider value={requestClose}>
      <div
        // Starts BELOW the custom title bar (`--titlebar-h`, set by Titlebar).
        // Electron hands the bar's `-webkit-app-region: drag` rectangle to the
        // OS by position, whatever is painted over it — a dialog scrolled up
        // under those pixels had an unclickable Close button.
        className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h,0px)] z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
        onMouseDown={requestClose}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          aria-busy={busy ? true : undefined}
          tabIndex={-1}
          className={`my-8 w-full ${width} rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl shadow-black/40 outline-none`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
            <h3 className="font-medium">{title}</h3>
            <button
              type="button"
              onClick={requestClose}
              className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-200"
              aria-label="Close"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          {ask === 'discard' && (
            <div
              role="alertdialog"
              aria-label="Discard your changes?"
              className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/10 px-5 py-2.5 text-sm text-amber-100"
            >
              <span>Discard your changes? They are not saved.</span>
              <span className="flex gap-2">
                <Button ref={keepRef} variant="default" onClick={() => setAsk(null)}>
                  Keep editing
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setAsk(null);
                    onCloseRef.current();
                  }}
                >
                  Discard changes
                </Button>
              </span>
            </div>
          )}
          {ask === 'busy' && (
            <p role="status" className="border-b border-white/5 bg-neutral-800/60 px-5 py-2 text-xs text-neutral-300">
              {busyText} — this stays open until it finishes, so nothing is lost.
            </p>
          )}
          <div className="p-5">{children}</div>
        </div>
      </div>
    </ModalDismissContext.Provider>
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

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'default' | 'ghost' | 'danger' | 'success';
    loading?: boolean;
  }
>(function Button({ variant = 'default', loading = false, className = '', children, disabled, ...rest }, ref) {
  const styles: Record<string, string> = {
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-900/40',
    success: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-900/40',
    danger: 'bg-red-600/90 hover:bg-red-600 text-white',
    default: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 ring-1 ring-white/5',
    ghost: 'bg-transparent hover:bg-neutral-800/70 text-neutral-300',
  };
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

/** `data-tour` passes through so the guided tour can spotlight a specific card
 *  rather than the nav item that leads to its page (see dashboard/Tour.tsx). */
export function Card({
  className = '',
  children,
  ...rest
}: {
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...rest}
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

/** One row of a {@link Dropdown}. The optional fields turn a flat list into a
 *  grouped menu: rows sharing a `group` render under one header (in the order
 *  given — keep a group's rows adjacent), `description` is a second dimmer
 *  line, `disabled` rows are shown but not selectable (their `title` says why). */
export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
  title?: string;
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
  buttonLabel,
  ariaLabel,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  buttonClassName?: string;
  className?: string;
  disabled?: boolean;
  /** Override the closed-state text (default: the selected option's label). */
  buttonLabel?: string;
  /** Accessible name when no enclosing label gives one. */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  /** The highlighted option (keyboard / pointer) while open. */
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optId = (i: number) => `${listId}-o${i}`;
  // Set by a real press on the button. A click without it is the enclosing
  // <label> (dashboard Field) re-dispatching the user's click on the label
  // text onto its first control — i.e. this button. That synthetic click used
  // to re-open a list the outside mousedown had just closed.
  const pressed = useRef(false);
  const typed = useRef({ text: '', at: 0 });

  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selectedIndex = options.findIndex((o) => o.value === value);

  const openList = (at?: 'first' | 'last') => {
    if (rootRef.current) {
      // Open upward when the list would run past the window bottom and
      // there is more room above (the Cue Card is small).
      const r = rootRef.current.getBoundingClientRect();
      const room = 240;
      setOpenUp(r.bottom + room > window.innerHeight && r.top > window.innerHeight - r.bottom);
    }
    const start =
      at === 'last'
        ? enabled[enabled.length - 1]
        : at === 'first'
          ? enabled[0]
          : enabled.includes(selectedIndex)
            ? selectedIndex
            : enabled[0];
    setActive(start ?? -1);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    onChange(o.value);
  };
  const toggle = () => (open ? close() : openList());
  const step = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at < 0 ? (dir === 1 ? 0 : enabled.length - 1) : Math.min(enabled.length - 1, Math.max(0, at + dir));
    setActive(enabled[next]);
  };
  /** Type-ahead: jump to the next option whose label starts with what was typed. */
  const typeAhead = (ch: string) => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + ch : ch, at: now };
    const q = typed.current.text.toLowerCase();
    const from = Math.max(0, enabled.indexOf(active));
    const order = [...enabled.slice(from + (q.length === 1 ? 1 : 0)), ...enabled.slice(0, from + (q.length === 1 ? 1 : 0))];
    const hit = order.find((i) => options[i].label.toLowerCase().startsWith(q));
    if (hit !== undefined) setActive(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // no synthesized click to follow, no page scroll
        openList(e.key === 'ArrowUp' ? 'last' : undefined);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        openList(e.key === 'Home' ? 'first' : 'last');
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(enabled[0] ?? -1);
        break;
      case 'End':
        e.preventDefault();
        setActive(enabled[enabled.length - 1] ?? -1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) choose(active);
        else close();
        break;
      case 'Escape':
        // The inner control closes first: an enclosing Modal must not close
        // along with the list (it skips an Escape already handled).
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(); // focus moves on as usual
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(e.key);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    // Escape with focus elsewhere (the list was opened by pointer and focus
    // moved): still closes the list, not the dialog around it.
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    // Close when the window itself loses focus. Without this the list can be
    // left hanging open: over the click-through Cue Card a click on a
    // non-interactive region is forwarded to the app behind, so the mousedown
    // above never reaches this document.
    const onWindowBlur = () => close();
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open]);

  // Keep the highlighted option in view while arrowing through a long list.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const selected = options.find((o) => o.value === value);
  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-label={ariaLabel}
        className={buttonClassName}
        onMouseDown={() => {
          pressed.current = true;
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Only a click that began with a press on THIS button counts; the
          // label's forwarded click (no press here) is ignored.
          if (!pressed.current) return;
          pressed.current = false;
          toggle();
        }}
      >
        <span className="truncate">{buttonLabel ?? selected?.label ?? value}</span>
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
          id={listId}
          role="listbox"
          className={`absolute left-0 z-[60] max-h-64 w-full min-w-max max-w-[22rem] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50 ${
            openUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={optId(i)}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              title={o.title}
              // Keep focus on the button (the list is aria-activedescendant).
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onClick={(e) => {
                // Same <label> quirk as the toggle button above: inside a
                // Field, the label would re-dispatch this click onto the
                // toggle button and REOPEN the list right after choosing.
                // Cancelling the click cancels that.
                e.preventDefault();
                e.stopPropagation();
                choose(i);
              }}
              className={o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
            >
              {o.group && o.group !== options[i - 1]?.group && (
                <div
                  role="presentation"
                  className={`px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 ${
                    i > 0 ? 'mt-1 border-t border-white/5' : ''
                  }`}
                >
                  {o.group}
                </div>
              )}
              <div
                className={`px-3 py-1.5 text-left text-sm transition-colors ${
                  o.value === value
                    ? 'bg-indigo-600/25 text-indigo-200'
                    : i === active
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-200'
                } ${i === active ? 'ring-1 ring-inset ring-indigo-400/60' : ''}`}
              >
                <span className="block truncate">{o.label}</span>
                {o.description && (
                  <span className="block truncate text-[11px] leading-snug text-neutral-500">{o.description}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Converts native HTML `title` tooltips into an in-window tooltip, app-wide.
 *
 * A native `title` tooltip renders as a SEPARATE OS window that does NOT inherit
 * the app window's screen-capture exclusion — so hovering any titled element
 * (nav links, buttons, icons) shows the tooltip in a Zoom/Meet screen share even
 * while the app itself is hidden. This intercepts the `title` on hover (well
 * before the OS tooltip's ~0.5s delay), strips it so the native tooltip never
 * appears, and renders the same text inside the window's own DOM instead (which
 * IS covered by the exclusion). Mount ONCE at the app root — it covers every
 * view and every current/future `title`, so individual call sites keep using the
 * ordinary `title` attribute.
 */
export function TooltipShield() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; up: boolean } | null>(null);
  useEffect(() => {
    let curEl: HTMLElement | null = null;
    const titled = (n: EventTarget | null): HTMLElement | null => {
      let el = n as HTMLElement | null;
      while (el && el !== document.body) {
        if (el.getAttribute && (el.getAttribute('title') || el.getAttribute('data-tip'))) return el;
        el = el.parentElement;
      }
      return null;
    };
    const show = (el: HTMLElement): void => {
      let text = el.getAttribute('title');
      if (text) {
        // Strip the native title so the OS tooltip window never appears; keep the
        // text for our in-window tooltip and (if the control has no visible text)
        // for accessibility.
        el.setAttribute('data-tip', text);
        if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text);
        el.removeAttribute('title');
      } else {
        text = el.getAttribute('data-tip');
      }
      if (!text) return setTip(null);
      const r = el.getBoundingClientRect();
      const up = r.bottom + 44 > window.innerHeight;
      setTip({
        text,
        x: Math.min(Math.max(r.left + r.width / 2, 8), window.innerWidth - 8),
        y: up ? r.top - 6 : r.bottom + 6,
        up,
      });
    };
    const onOver = (e: Event): void => {
      const el = titled(e.target);
      if (el === curEl) return;
      curEl = el;
      if (el) show(el);
      else setTip(null);
    };
    const hide = (): void => {
      curEl = null;
      setTip(null);
    };
    // Keyboard users get the same detail: focusing a titled control shows it.
    const onFocusIn = (e: FocusEvent): void => {
      const el = titled(e.target);
      curEl = el;
      if (el) show(el);
      else setTip(null);
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.up ? '-100%' : '0'})`,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
      className="max-w-xs rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] leading-snug text-neutral-100 shadow-lg shadow-black/60"
    >
      {tip.text}
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
    const p = child.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean };
    options.push({ value: String(p.value ?? ''), label: nodeText(p.children), ...(p.disabled ? { disabled: true } : {}) });
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
