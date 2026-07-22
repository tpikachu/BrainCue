import { noDrag } from '../lib/style';

/** Backend session failure — surfaced so the Cue Card never silently shows a
 *  "listening" state after the transcription socket / provider call has failed. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      data-ct-interactive
      className="mb-2 flex shrink-0 items-start justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/15 px-2 py-1 text-[11px] text-red-300"
      style={noDrag}
    >
      <span className="min-w-0">⚠ {message}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-red-300/70 hover:text-red-200"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
