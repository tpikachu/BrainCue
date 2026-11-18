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
  Session,
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
  { value: 'quiet', label: 'Quiet', desc: 'Rare, high-confidence cards only. Questions become cards, not answers.' },
  { value: 'balanced', label: 'Balanced', desc: 'Answers questions asked in the room; notes clear action items and decisions. The default.' },
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
  /** Can questions be detected and answered — does the provider the chat
   *  tasks resolve to have a key? (Any provider: the OpenAI key is no longer
   *  required — services/readiness.ts.) */
  chatReady: boolean;
  /** The readiness service's own wording for a chat problem, when known. */
  chatProblem?: string;
  /** Can the chosen transcription engine run — cloud needs the OpenAI key,
   *  local needs its model downloaded (`AppSettings.sttReady`). */
  sttReady: boolean;
  sttProblem?: string;
  sessionLive: boolean;
  activity?: ContextPackKind;
  spaceId?: string | null;
}): string | null {
  if (a.sessionLive) return 'A session is already live — stop it first.';
  if (!a.chatReady)
    return a.chatProblem ?? 'No AI provider is set up — add an API key in Settings → Language Models.';
  if (!a.sttReady)
    return a.sttProblem ?? 'Transcription is not set up — choose an engine under Settings → Speech-to-Text.';
  if (!a.profile) return 'Pick a profile.';
  const config = ACTIVITIES[a.activity ?? DEFAULT_ACTIVITY];
  if (config?.needsResume && !a.profile.parsedResume)
    return 'Interviews answer from your résumé — add one to this profile.';
  if (config?.needsSpace && !a.spaceId)
    // Said as a role: that is what an interview Space is to the person using it.
    return 'Choose the role this interview is for, or add one — each round builds on the last.';
  return null;
}

/** The transparency summary shown before Start: exactly what is captured
 *  locally and what leaves the machine. Mirrors the PRD privacy contract —
 *  keep the strings honest when the pipeline changes. */
export function captureSummary(a: {
  /** The activity's `listensTo`: a call ('system') is heard on BOTH sides —
   *  the call's audio and the microphone; 'mic' is the microphone alone. */
  listensTo: 'system' | 'mic';
  spaceTitle: string | null;
  activity?: ContextPackKind;
  /** The transcription engine that will run, when known (readiness). */
  sttEngine?: 'cloud' | 'local';
  /** The AI provider answers go to, by name, when known (readiness). */
  chatProvider?: string;
}): { captured: string[]; sent: string[]; neverSent: string[] } {
  const scope = a.spaceTitle
    ? `your profile and the “${a.spaceTitle}” Space`
    : 'your profile';
  const to = a.chatProvider ? `, to ${a.chatProvider}` : '';
  // The pipeline differs by MODE, not by activity — a project call and a
  // standup send exactly the same things.
  const mode: SessionMode = a.activity ? activity(a.activity).mode : 'interview';
  return {
    captured: [
      mode === 'companion'
        ? 'Your microphone, transcribed in real time — ONLY while this session runs (nothing listens before Start or after Stop).'
        : a.listensTo === 'system'
          ? 'System audio (the other side of your call) AND your microphone, both transcribed in real time. Questions are taken from the call only.'
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
      // Said for the engine that will actually run, when it is known.
      a.sttEngine === 'local'
        ? 'No audio — it is transcribed on this device.'
        : a.sttEngine === 'cloud'
          ? a.listensTo === 'system' && mode !== 'companion'
            ? 'Audio — both streams — to OpenAI Realtime, for transcription.'
            : 'Audio to OpenAI Realtime, for transcription.'
          : a.listensTo === 'system' && mode !== 'companion'
            ? 'Audio — both streams — to the transcription engine (OpenAI Realtime with your key, or nothing at all with the local engine).'
            : 'Audio to the transcription engine (OpenAI Realtime with your key, or nothing at all with the local engine).',
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
          : [`Per detected question: the question text + the top-5 matching chunks from ${scope}${to}.`]),
    ],
    neverSent: [
      'Your API key (main process only).',
      'Your full résumé or documents — only the retrieved chunks above.',
      'Your screen (unless you explicitly capture a region to solve).',
    ],
  };
}

/**
 * Is this session an interview the user can pick up again? A real (`live`)
 * interview-mode session in an interview Space. Meetings and companion
 * sessions run other modes; mock interviews and sparring drills are
 * rehearsals (`kind` mock/sparring) — none of them is resumable as an
 * interview, and offering "Resume" on a standup's Space was a real bug.
 * v1 rows carry no activity; their mode decides.
 */
export function isResumableInterview(s: Pick<Session, 'kind' | 'mode' | 'activity' | 'jobId'>): boolean {
  return s.kind === 'live' && s.mode === 'interview' && (s.activity == null || s.activity === 'job') && !!s.jobId;
}

/**
 * The Space a start flow opens on, so a returning user does not choose again:
 *  1. the Space of the most recent session of this activity (newest first)
 *     — what the user actually chose last time;
 *  2. for an activity that needs a Space, the only one there is;
 *  3. otherwise none — never a guess among several.
 *
 * Derived from the CURRENT profile's Spaces and sessions every time, so it
 * cannot go stale: a deleted Space is no longer in `spaces`, and a profile
 * switch replaces both lists.
 */
export function defaultSpaceFor(
  act: ContextPackKind,
  spaces: { id: string; kind?: string | null }[],
  sessions: Pick<Session, 'kind' | 'mode' | 'activity' | 'jobId'>[],
): string {
  const ofActivity = spacesFor(spaces, act);
  const ids = new Set(ofActivity.map((s) => s.id));
  const used = sessions.find((s) =>
    act === 'job' ? isResumableInterview(s) && ids.has(s.jobId!) : s.kind === 'live' && !!s.jobId && ids.has(s.jobId) && activityOf(s.activity) === act,
  );
  if (used?.jobId) return used.jobId;
  if (ACTIVITIES[act]?.needsSpace && ofActivity.length === 1) return ofActivity[0].id;
  return '';
}

/** The activity "Other conversation" opens on: the last non-interview
 *  activity this profile actually used, else a meeting. */
export function lastOtherActivity(sessions: Pick<Session, 'kind' | 'activity'>[]): ContextPackKind {
  const s = sessions.find((x) => x.kind === 'live' && x.activity && x.activity !== 'job' && startableActivities().includes(x.activity));
  return s?.activity ?? 'meeting';
}

/**
 * The start flow's Space choice, one step at a time — what the modal does
 * whenever its lists change. `null` = leave the choice as it is.
 *  - Nothing decided until BOTH lists belong to the current profile and
 *    activity (`spaces`/`sessions` null while loading or stale).
 *  - A choice the user made stands while it is still in the list.
 *  - A choice that is gone (deleted, or another profile's after a switch) is
 *    dropped, and the default applies — never started against.
 */
export function nextSpaceChoice(a: {
  activity: ContextPackKind;
  spaces: { id: string; kind?: string | null }[] | null;
  sessions: Pick<Session, 'kind' | 'mode' | 'activity' | 'jobId'>[] | null;
  spaceId: string;
  chosen: boolean;
}): { spaceId: string; chosen: boolean } | null {
  if (!a.spaces || !a.sessions) return null;
  if (a.chosen && a.spaces.some((s) => s.id === a.spaceId)) return null;
  const next = { spaceId: defaultSpaceFor(a.activity, a.spaces, a.sessions), chosen: false };
  return next.spaceId === a.spaceId && next.chosen === a.chosen ? null : next;
}
