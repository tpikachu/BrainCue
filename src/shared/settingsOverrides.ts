/**
 * Per-task override edits, applied by main against the STORED map
 * (`settings.set` → `modelOverrides` / `effortOverrides`).
 *
 * A renderer used to read the whole `models` / `reasoningEfforts` map, change
 * one key and write the whole map back. Any read that was older than the
 * stored state (a delayed reply, a second save in flight, another window's
 * write in between) then restored values the user had since replaced —
 * changing only the reasoning effort could put back an earlier model and
 * provider (M7.2a review, AI-01). An edit now names only the keys it changes,
 * and main merges them synchronously, so no other key can be written from a
 * stale copy.
 *
 * `null` or `''` clears a key (→ Automatic / the default).
 */
export type OverrideEdits = Record<string, string | null>;

export function mergeOverrides(stored: Record<string, string>, edits: OverrideEdits): Record<string, string> {
  const next: Record<string, string> = { ...stored };
  for (const [key, value] of Object.entries(edits)) {
    const v = value?.trim();
    if (v) next[key] = v;
    else delete next[key];
  }
  return next;
}
