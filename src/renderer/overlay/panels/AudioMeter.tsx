import { noDrag } from '../lib/style';

/** Audio meter (expanded mode) — driven by a level broadcast from main. It only
 *  animates while someone is actually speaking; otherwise it sits flat so it
 *  doesn't twitch on background noise. */
export function AudioMeter({ level, speaking }: { level: number; speaking: boolean }) {
  return (
    <div
      data-ct-interactive
      className="mb-2 flex h-5 shrink-0 items-end gap-0.5"
      style={noDrag}
      title={speaking ? 'Speaking…' : 'Quiet'}
    >
      {[0.6, 0.85, 1, 0.7, 0.95, 0.6, 0.8].map((m, i) => (
        <span
          key={i}
          className={`w-1 rounded-sm transition-[height] duration-75 ${
            speaking ? 'bg-green-500/80' : 'bg-neutral-700'
          }`}
          style={{ height: `${speaking ? Math.max(8, Math.min(100, level * 320 * m)) : 8}%` }}
        />
      ))}
    </div>
  );
}
