import { api } from '../../lib/api';
import { noDrag } from '../lib/style';

/** Multi-image problem captures: a long coding problem scrolls past one
 *  viewport, so the user captures several (Region button → scroll → repeat)
 *  and we send them together. Shown whether or not a session is live. */
export function CapturesPanel({ captures }: { captures: string[] }) {
  return (
    <div
      data-ct-interactive
      className="mb-2 shrink-0 rounded-lg border border-neutral-700 bg-neutral-950/60 p-2"
      style={noDrag}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-neutral-400">
        <span>📸 Problem captures ({captures.length}/8)</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void api.capture.solveBuffer()}
            className="rounded-md bg-green-600/90 px-2 py-1 font-medium text-white transition-colors hover:bg-green-600"
          >
            Solve {captures.length > 1 ? `${captures.length} shots` : ''}
          </button>
          <button
            onClick={() => void api.capture.clearBuffer()}
            className="rounded-md bg-neutral-800 px-2 py-1 font-medium text-neutral-300 transition-colors hover:bg-neutral-700"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {captures.map((img, i) => (
          <img
            key={i}
            src={img}
            alt={`capture ${i + 1}`}
            className="h-12 w-auto shrink-0 rounded border border-neutral-700"
          />
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-neutral-500">
        Scroll the problem &amp; capture each screen, then Solve. Tip: copying the problem text
        (⚡) is even more accurate when it&apos;s selectable.
      </p>
    </div>
  );
}
