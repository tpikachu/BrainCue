/** The little animated "listening" bars (header + empty-state). */
export function EqualizerBars() {
  return (
    <span className="flex h-4 items-end gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="eq-bar" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}
