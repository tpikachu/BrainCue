/** Feature flags for modes/surfaces that are designed but not shipped.
 *  Planned things are GATED here rather than rendered as dead-looking cards —
 *  flipping a flag is the release switch when its prompt lands (Meeting in
 *  Prompt 7, Memory in 8, Voice in 9, Companion in 10). Shared so main-process
 *  mode registration can consult the same source of truth later. */
export const FLAGS = {
  /** Interviewer Assist mode (question suggestions, coverage tracking). */
  interviewerAssist: false,
  /** Meeting Copilot mode (quiet ambient contributions in meetings). Shipped
   *  behind its deterministic acceptance suite (meeting.acceptance.test.ts);
   *  surfaces with a Labs badge while it collects real-world hours. */
  meeting: true,
  /** Tutor mode (voice dialogue + drills over your material). */
  tutor: false,
  /** Companion mode (ambient presence with memory) — Prompt 10. Shipped
   *  behind its scripted evaluation harness (companion.eval.test.ts: zero
   *  low-confidence interruptions, dedupe-in-cooldown, provenance-correct
   *  recall, hard mute, teardown); surfaces with a Labs badge while it
   *  collects real-world hours. */
  companion: true,
  /** Long-term memory (Library tab + status chip + engine recall). Shipped
   *  with the review-first substrate (Prompt 8): consent is still OFF by
   *  default per user — this flag only surfaces the UI. */
  memory: true,
  /** "Talk to BrainCue" — the voice/summon layer (Prompt 9): global
   *  push-to-talk, spoken replies with barge-in, no-session quick ask. Voice
   *  is an output surface over the contribution pipeline, not a mode. */
  voice: true,
} as const;

export type FlagName = keyof typeof FLAGS;
