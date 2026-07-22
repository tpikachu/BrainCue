import { FLAGS } from '@shared/flags';
import type { CompanionPresence, Presence, Profile } from '@shared/types';

/** The universal start flow's mode catalog (StartSessionModal + Home). One
 *  entry per SessionMode; `enabled` is the flag gate. A disabled mode is still
 *  LISTED — shown as "Coming soon" and not startable — so the catalog reads
 *  honestly about what exists instead of hiding the roadmap. */
export interface StartMode {
  id: 'interview' | 'practice' | 'interviewer_assist' | 'meeting' | 'tutor' | 'companion';
  label: string;
  desc: string;
  enabled: boolean;
}

export const START_MODES: StartMode[] = [
  {
    id: 'interview',
    label: 'Interview Copilot',
    desc: 'You answer — grounded cues stream into the Cue Card.',
    enabled: true,
  },
  {
    id: 'practice',
    label: 'Practice',
    desc: 'Rehearse aloud with an AI interviewer + coaching.',
    enabled: true,
  },
  {
    id: 'interviewer_assist',
    label: 'Interviewer Assist',
    desc: 'You ask — suggestions, coverage, evaluation draft.',
    enabled: FLAGS.interviewerAssist,
  },
  {
    id: 'meeting',
    label: 'Meeting Copilot',
    desc: 'Quiet ambient context, open questions, action items.',
    enabled: FLAGS.meeting,
  },
  { id: 'tutor', label: 'Tutor', desc: 'Dialogue + drills over your material.', enabled: FLAGS.tutor },
  {
    id: 'companion',
    label: 'Companion',
    desc: 'Ambient presence with memory while you work.',
    enabled: FLAGS.companion,
  },
];

/** The modes that can actually be STARTED right now. Pickers render the full
 *  catalog (gated ones disabled + "Coming soon"); this is the startable set. */
export const enabledModes = (): StartMode[] => START_MODES.filter((m) => m.enabled);

/** Presence options for ambient modes (Meeting) — labels for the explicit
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

/** Can a session start? Returns the FIRST blocking reason so the UI can say
 *  exactly what to fix (and never half-starts anything). */
export function startBlocker(a: {
  profile: Profile | undefined;
  apiKeyPresent: boolean;
  sessionLive: boolean;
}): string | null {
  if (a.sessionLive) return 'A session is already live — stop it first.';
  if (!a.apiKeyPresent) return 'Add your OpenAI API key in Settings.';
  if (!a.profile) return 'Pick a profile.';
  if (!a.profile.parsedResume) return 'This profile has no parsed résumé — add one in the Library.';
  return null;
}

/** The transparency summary shown before Start: exactly what is captured
 *  locally and what leaves the machine. Mirrors the PRD privacy contract —
 *  keep the strings honest when the pipeline changes. */
export function captureSummary(a: {
  source: 'system' | 'mic';
  spaceTitle: string | null;
  mode?: StartMode['id'];
}): { captured: string[]; sent: string[]; neverSent: string[] } {
  const scope = a.spaceTitle
    ? `your profile and the “${a.spaceTitle}” Space`
    : 'your profile';
  return {
    captured: [
      a.mode === 'companion'
        ? 'Your microphone, transcribed in real time — ONLY while this session runs (nothing listens before Start or after Stop).'
        : a.source === 'system'
          ? 'System audio (the other side of your call), transcribed in real time.'
          : 'Your microphone, transcribed in real time.',
      'The transcript stays in the local database on this machine.',
    ],
    sent: [
      'Audio to OpenAI for transcription (Realtime API, your key).',
      ...(a.mode === 'meeting'
        ? [
            'Ambiguous turns: the turn + a few recent turns, for salience scoring (deterministic rules filter greetings/small talk first).',
            `When a card is made: the turn + the top-5 matching chunks from ${scope}.`,
          ]
        : a.mode === 'companion'
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
