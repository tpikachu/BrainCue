/**
 * Which profile the app is currently working for.
 *
 * Every profile-scoped surface used to ask separately (a `<Select>` in each
 * Library tab, in the start modal, on each interview page), so "whose dashboard
 * is this?" had five answers that could disagree. It is now one stored setting,
 * chosen in the sidebar — but a stored id is a pointer, and pointers dangle:
 * profiles get deleted, databases get restored, `active_profile_id` outlives
 * the row it names.
 *
 * A dangling id must never blank the app. Falling back to a profile that exists
 * is always better than showing every list empty behind a switcher that reads
 * as if something is selected, because "empty" is indistinguishable from
 * "broken" and the user has no way to tell which they are looking at.
 */
export function resolveActiveProfile(
  storedId: string | null | undefined,
  profileIds: readonly string[],
): string | null {
  if (storedId && profileIds.includes(storedId)) return storedId;
  return profileIds[0] ?? null;
}
