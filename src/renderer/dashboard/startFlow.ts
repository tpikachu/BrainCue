import {
  ACTIVITIES,
  DEFAULT_ACTIVITY,
  activity,
  activityOf,
  startableActivities,
} from '@shared/activities';
import type { ActivityConfig } from '@shared/activities';
import type {
  CompanionPresence,
  ContextPackKind,
  Presence,
  Profile,
  SessionMode,
} from '@shared/types';

/**
 * The universal start flow's catalog — ONE list.
 *
 * There used to be two: a Mode picker (Interview Copilot / Practice / Meeting
 * Copilot / Companion / …) and, inside a Space, a kind. Both answered "what am
 * I about to do?", they overlapped item-for-item, and their defaults
 * contradicted — the modal opened on Interview while a new Space defaulted to
 * Meeting. See shared/activities.ts.
 *
 * So the user picks an ACTIVITY and the engine mode follows from it. Modes that
 * are not built are not listed as activities either: a "Coming soon" tile in
 * the one list you must answer to start is an obstacle, not honesty. The
 * roadmap lives on Home, where reading it costs nothing.
 */
export interface StartActivity extends ActivityConfig {
  id: ContextPackKind;
}

export const START_ACTIVITIES: StartActivity[] = startableActivities().map((k) => ({
  id: k,
  ...ACTIVITIES[k],
}));

/** Practice is not an activity — it is something you do ABOUT an interview, in
 *  its own drill pages. It used to sit in the mode list, where picking it did
 *  not start anything; it navigated away. It now appears under the Interview
 *  activity as what it is: preparation. */
export const PRACTICE_LINKS: { to: '/mock' | '/sparring'; label: string }[] = [
  { to: '/mock', label: 'Mock interview' },
  { to: '/sparring', label: 'Sparring drill' },
];

/**
 * The Spaces that can be picked for an activity.
 *
 * A Space IS a saved activity, so a Space of a different one is not a candidate:
 * its documents, its archive format, and everything it has accumulated belong to
 * what it is. Offering all of them turned the list into a directory of
 * everything the profile had ever set up, and picking one silently rewrote the
 * activity chosen a moment earlier.
 *
 * Kept here rather than inline in the modal so the rule is testable on its own
 * and the picker and the "does the current selection survive?" check can never
 * disagree about it.
 */
export function spacesFor<T extends { kind?: string | null }>(
  spaces: T[],
  activity: ContextPackKind,
): T[] {
  return spaces.filter((s) => activityOf(s.kind) === activity);
}

/** Presence options for ambient activities — labels for the explicit
 *  threshold/cooldown levels in the engine's trigger/presence.ts. */
export const PRESENCE_OPTIONS: { value: Presence; label: string; desc: string }[] = [
  { value: 'summoned', label: 'Summoned only', desc: 'Never speaks up — answers only when you ask.' },
  { value: 'quiet', label: 'Quiet', desc: 'Rare, high-confidence cards only. The default.' },
  { value: 'balanced', label: 'Balanced', desc: 'Speaks up on clear action items, decisions, and gaps.' },
  { value: 'active', label: 'Active', desc: 'Contributes whenever it plausibly helps.' },
];

/** Companion posture options — labels for the InterjectionPolicy levels in
 *  the engine's trigger/companionPresence.ts. */
export const COMPANION_PRESENCE_OPTIONS: {
  value: CompanionPresence;
  label: string;
  desc: string;
}[] = [
  { value: 'off', label: 'Off', desc: 'Hard mute — no automatic contributions at all.' },
  { value: 'on_demand', label: 'On demand', desc: 'Answers only when you summon it.' },
  { value: 'assistive', label: 'Assistive', desc: 'Speaks up for clearly useful things. The default.' },
  { value: 'proactive', label: 'Proactive', desc: 'Contributes whenever it plausibly helps.' },
];

/** Hard session budget choices for companion cost governance. */
export const BUDGET_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'No cap' },
  { value: 25, label: '$0.25 per session' },
  { value: 50, label: '$0.50 per session' },
  { value: 100, label: '$1.00 per session' },
  { value: 200, label: '$2.00 per session' },
];

/**
 * Can a session start? Returns the FIRST blocking reason so the UI can say
 * exactly what to fix (and never half-starts anything).
 *
 * Both per-activity gates are read off the catalog, never hardcoded here.
 *
 * The résumé gate used to be unconditional, which meant you could not sit in on
 * your own standup without first uploading a CV — the single loudest way the app
 * still insisted it was an interview tool. Only the Interview activity genuinely
 * needs one: it answers AS the candidate, from their history.
 *
 * The Space gate is the same shape for the same reason. A Space is where a
 * conversation is kept, so starting without one means keeping nothing — fine for
 * a call that happens once, wrong for an interview, which is one round of
 * several for one role and whose value is entirely cumulative.
 */
export function startBlocker(a: {
  profile: Profile | undefined;
  apiKeyPresent: boolean;
  sessionLive: boolean;
  activity?: ContextPackKind;
  spaceId?: string | null;
}): string | null {
  if (a.sessionLive) return 'A session is already live — stop it first.';
  if (!a.apiKeyPresent) return 'Add your OpenAI API key in Settings.';
  if (!a.profile) return 'Pick a profile.';
  const config = ACTIVITIES[a.activity ?? DEFAULT_ACTIVITY];
  if (config?.needsResume && !a.profile.parsedResume)
    return 'Interviews answer from your résumé — add one to this profile in the Library.';
  if (config?.needsSpace && !a.spaceId)
    return 'Pick the Space this interview is for, or create one — otherwise there is nowhere to keep what it learns.';
  return null;
}

/** The transparency summary shown before Start: exactly what is captured
 *  locally and what leaves the machine. Mirrors the PRD privacy contract —
 *  keep the strings honest when the pipeline changes. */
export function captureSummary(a: {
  source: 'system' | 'mic';
  spaceTitle: string | null;
  activity?: ContextPackKind;
}): { captured: string[]; sent: string[]; neverSent: string[] } {
  const scope = a.spaceTitle
    ? `your profile and the “${a.spaceTitle}” Space`
    : 'your profile';
  // The pipeline differs by MODE, not by activity — a project call and a
  // standup send exactly the same things.
  const mode: SessionMode = a.activity ? activity(a.activity).mode : 'interview';
  return {
    captured: [
      mode === 'companion'
        ? 'Your microphone, transcribed in real time — ONLY while this session runs (nothing listens before Start or after Stop).'
        : a.source === 'system'
          ? 'System audio (the other side of your call), transcribed in real time.'
          : 'Your microphone, transcribed in real time.',
      'The transcript stays in the local database on this machine.',
      // What survives the session, said before it starts. A Space is the only
      // place a conversation is kept, so its absence is a real consequence and
      // belongs here rather than being discovered at the save prompt.
      a.spaceTitle
        ? `Afterwards, if you keep it: a short summary and any memory suggestions, filed in “${a.spaceTitle}”.`
        : 'Afterwards: nothing is summarised or remembered — pick a Space for that (you can still choose one when it ends).',
    ],
    sent: [
      'Audio to OpenAI for transcription (Realtime API, your key).',
      ...(mode === 'meeting'
        ? [
            'Ambiguous turns: the turn + a few recent turns, for salience scoring (deterministic rules filter greetings/small talk first).',
            `When a card is made: the turn + the top-5 matching chunks from ${scope}.`,
          ]
        : mode === 'companion'
          ? [
              'Ambiguous turns: the turn + a few recent turns, for salience scoring (silence, small talk, mute, DND, and cooldowns never spend a model call).',
              `When a card is made: the turn + the top-5 matching chunks from ${scope}, plus any APPROVED memories that matched.`,
            ]
          : [`Per detected question: the question text + the top-5 matching chunks from ${scope}.`]),
    ],
    neverSent: [
      'Your API key (main process only).',
      'Your full résumé or documents — only the retrieved chunks above.',
      'Your screen (unless you explicitly capture a region to solve).',
    ],
  };
}
