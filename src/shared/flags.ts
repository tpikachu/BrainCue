/** Feature flags for modes/surfaces that are designed but not shipped, plus one
 *  that is shipped and deliberately quarantined (`jobSearch`).
 *
 *  Planned things are GATED here rather than rendered as dead-looking cards, and
 *  flipping a flag is the release switch. An activity whose mode is off is not
 *  offered at all rather than downgraded into another mode — see
 *  `activities.ts`, which reads these. Shared so main-process mode registration
 *  can consult the same source of truth. */
export const FLAGS = {
  /** Interviewer Assist mode (question suggestions, coverage tracking). */
  interviewerAssist: false,
  /** Meeting Copilot mode (quiet ambient contributions in meetings). Shipped
   *  behind its deterministic acceptance suite (meeting.acceptance.test.ts);
   *  surfaces with a Labs badge while it collects real-world hours. */
  meeting: true,
  /** Tutor mode (voice dialogue + drills over your material). */
  tutor: false,
  /** Companion mode (ambient presence with memory). Shipped behind its
   *  scripted evaluation harness (companion.eval.test.ts: zero
   *  low-confidence interruptions, dedupe-in-cooldown, provenance-correct
   *  recall, hard mute, teardown); surfaces with a Labs badge while it
   *  collects real-world hours. */
  companion: true,
  /** Long-term memory (its own nav section + status chip + engine recall).
   *  Shipped with the review-first substrate: consent is still OFF by default
   *  per user — this flag only surfaces the UI. */
  memory: true,
  /** "Talk to BrainCue" — the voice/summon layer: global push-to-talk, spoken
   *  replies with barge-in, no-session quick ask. Voice is an output surface
   *  over the contribution pipeline, not a mode. */
  voice: true,
  /**
   * Job-search tooling: Tailor Resume and the applications table.
   *
   * Shipped and working, but it belongs to the interview-copilot product rather
   * than to a companion for daily conversations, and leading Home with it
   * misrepresents what BrainCue now is. Quarantined rather than deleted: the
   * tables, IPC, repositories, and pages are all intact, and existing users'
   * data is untouched.
   *
   * NOT a kill switch for the retrieval path. `tailored` chunks are inert
   * because grounding only substitutes them for interview-family modes
   * (services/engine/grounding.ts), not because this flag is off — main never
   * reads FLAGS at all. Before flipping this back, read
   * docs/20-QUARANTINE.md: the entry point passes no Space, the page carries
   * its own profile picker, and the save prompt cannot see an
   * application-owned Space.
   */
  jobSearch: false,
  /**
   * The STAR story bank as its own managed surface (profile-editor card,
   * Library inventory row).
   *
   * Stays OFF: a bank of stories to curate is an interview-copilot feature,
   * and BrainCue is not that. Stories survive as a per-session OPTION instead —
   * see `sessions.useStories` and the interview start flow. That is what fixed
   * the state this flag used to create, where retrieval force-included stories
   * in every interview while the surface to see, edit, or delete them was
   * hidden. Nothing is now recalled that the user did not ask for in the
   * session that recalls it.
   */
  storyBank: false,
} as const;

export type FlagName = keyof typeof FLAGS;
