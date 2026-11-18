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

/** Where each kind of request goes, by provider NAME (main's
 *  `readiness.routes`, named for display). */
export interface SummaryRoutes {
  /** The answer and its context. */
  answer: string;
  /** Question detection (and follow-up prediction). */
  classify: string;
  /** The summary and memory suggestions when a session is kept. */
  parsing: string;
}

/** The transparency summary shown before Start: exactly what is captured
 *  locally and what leaves the machine, and to WHOM — each kind of request
 *  names the provider it is routed to (answers and question detection can
 *  go to different providers). Mirrors the pipeline: keep the strings honest
 *  when it changes (engineSession.ts answer(), questions.ts, followup.ts,
 *  trigger/salience.ts, sessionArchive.ts, memory/extractor.ts). */
export function captureSummary(a: {
  /** The activity's `listensTo`: a call ('system') is heard on BOTH sides —
   *  the call's audio and the microphone; 'mic' is the microphone alone. */
  listensTo: 'system' | 'mic';
  spaceTitle: string | null;
  activity?: ContextPackKind;
  /** The transcription engine that will run, when known (readiness). */
  sttEngine?: 'cloud' | 'local';
  /** Recipients per request kind, when known (readiness.routes). */
  routes?: SummaryRoutes;
  /** Document matching: embeddings send the question to OpenAI. */
  retrieval?: 'embeddings' | 'lexical';
}): { captured: string[]; sent: string[]; neverSent: string[] } {
  const scope = a.spaceTitle
    ? `your profile and the “${a.spaceTitle}” Space`
    : 'your profile';
  const to = (p: string | undefined) => (p ? `To ${p}` : 'To the AI provider');
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
            `${to(a.routes?.classify)}: ambiguous turns with a few recent turns, for salience scoring (rules filter greetings and small talk first).`,
            // A question asked in the room is answered through the interview's
            // answer path (engineSession.answerQuestion) — memories included.
            `${to(a.routes?.answer)}: when it answers or makes a card, the turn with recent conversation and the top-5 matching chunks from ${scope} — and, for an answer, any matching approved memories.`,
          ]
        : mode === 'companion'
          ? [
              `${to(a.routes?.classify)}: ambiguous turns with a few recent turns, for salience scoring (silence, small talk, mute, DND and cooldowns never spend a model call).`,
              `${to(a.routes?.answer)}: when a card is made, the turn with the top-5 matching chunks from ${scope}, plus any APPROVED memories that matched.`,
            ]
          : [
              // The answer request carries more than the question: the
              // bounded conversation (both sides), earlier suggestions and
              // approved memories (engineSession.ts answer()).
              `${to(a.routes?.answer)}: each detected question with the best-matching passages from ${scope}, plus recent and earlier conversation — what they and you said — BrainCue’s earlier suggestions, and any matching approved memories.`,
              `${to(a.routes?.classify)}: interviewer turns the rules can’t settle, with the last few turns (to tell whether they are questions), and each question with BrainCue’s answer (to predict a follow-up).`,
            ]),
      // Document matching by meaning embeds the question on OpenAI.
      ...(a.retrieval === 'embeddings'
        ? ['To OpenAI: the question (with the previous exchange, for a follow-up), to find matching passages.']
        : []),
      // Kept sessions are summarised and mined for memory suggestions.
      ...(a.spaceTitle
        ? [`${to(a.routes?.parsing)}: if you keep it afterwards, the transcript — for the summary and memory suggestions.`]
        : []),
    ],
    neverSent: [
      'Your API key (main process only).',
      'Your full résumé or documents — only the matching passages above.',
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

/** A Space as the start flow needs it: whose it is and what it is. */
export type SpaceRef = { id: string; profileId: string; kind?: string | null };

/** Can this Space be used for this start — this profile's, this activity? A
 *  Space handed in, remembered, or re-read before Start must still pass: a
 *  deleted one is null, another profile's or another activity's is refused. */
export function spaceFits(s: SpaceRef | null | undefined, a: { profileId: string; activity: ContextPackKind }): boolean {
  return !!s && s.profileId === a.profileId && activityOf(s.kind) === a.activity;
}

/** The Spaces this profile last used for this activity, newest first,
 *  distinct — the candidates for the default (at most `max`, so a run of
 *  deleted roles costs a bounded number of reads). */
export function lastUsedSpaceIds(
  act: ContextPackKind,
  sessions: Pick<Session, 'kind' | 'mode' | 'activity' | 'jobId'>[],
  max = 5,
): string[] {
  const ids: string[] = [];
  for (const s of sessions) {
    const used = act === 'job' ? isResumableInterview(s) : s.kind === 'live' && !!s.jobId && activityOf(s.activity) === act;
    if (used && s.jobId && !ids.includes(s.jobId)) ids.push(s.jobId);
    if (ids.length >= max) break;
  }
  return ids;
}

/**
 * The Space a start flow opens on, so a returning user does not choose again:
 *  1. the Space this profile most recently used for this activity — read by
 *     id from main, so it is found wherever it sits (the picker only holds a
 *     page) — if it still exists and still fits;
 *  2. for an activity that needs a Space, the only one there is;
 *  3. otherwise none — never a guess among several.
 */
export async function resolveDefaultSpace<T extends SpaceRef>(a: {
  activity: ContextPackKind;
  profileId: string;
  sessions: Pick<Session, 'kind' | 'mode' | 'activity' | 'jobId'>[];
  /** The first page of this activity's Spaces (unfiltered) and its total. */
  page: { items: T[]; total: number };
  get: (id: string) => Promise<T | null>;
}): Promise<T | null> {
  for (const id of lastUsedSpaceIds(a.activity, a.sessions)) {
    const s = await a.get(id).catch(() => null);
    if (spaceFits(s, a)) return s;
  }
  if (ACTIVITIES[a.activity]?.needsSpace && a.page.total === 1 && a.page.items.length === 1) return a.page.items[0];
  return null;
}

/** The picker's options: the loaded page, with the chosen Space kept in it
 *  even when it is not on that page (older than the page, or filtered out by
 *  a search) — a selection is never dropped because of where it sits. */
export function pickerOptions<T extends { id: string }>(items: T[], selected: T | null): T[] {
  return selected && !items.some((s) => s.id === selected.id) ? [selected, ...items] : items;
}

/** The activity "Other conversation" opens on: the last non-interview
 *  activity this profile actually used, else a meeting. */
export function lastOtherActivity(sessions: Pick<Session, 'kind' | 'activity'>[]): ContextPackKind {
  const s = sessions.find((x) => x.kind === 'live' && x.activity && x.activity !== 'job' && startableActivities().includes(x.activity));
  return s?.activity ?? 'meeting';
}
