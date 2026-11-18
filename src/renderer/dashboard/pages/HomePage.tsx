import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { FLAGS } from '@shared/flags';
import { ACTIVITIES, DEFAULT_ACTIVITY, activity as activityConfig } from '@shared/activities';
import { useActiveProfile } from '../../store/useProfileStore';
import type { ContextPackKind, Job, SessionListItem } from '@shared/types';
import { Badge, Page } from '../../components/ui';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession } from '../../store/useLiveSession';
import { StartSessionModal } from '../StartSessionModal';
import { SetupChecklist } from '../SetupChecklist';
import { lastOtherActivity } from '../startFlow';
import { durationMs, fmtDur } from '../../lib/format';
import {
  BoltIcon,
  ClipboardCheckIcon,
  GraduationCapIcon,
  MicIcon,
  SparklesIcon,
  UsersIcon,
} from '../../components/icons';

type IconType = (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

/** "Jordan Lee" → "Jordan". A greeting uses the name someone is called, and a
 *  single-word name is left exactly as it is. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** Home (docs/23-INTERVIEW-COPILOT.md §7): ONE dominant action — Start
 *  interview — then a few small secondary ones, recent sessions, and
 *  everything else BrainCue does grouped under "More ways to use BrainCue".
 *  It used to be five equal launch cards and a catalog of activities, so the
 *  first screen asked "which of these?" before it asked anything useful.
 *  Every start goes through the one start flow (docs/18-ACTIVITIES.md); what
 *  is not built yet stays in a compact Labs strip — never dead-looking cards.
 *
 *  Everything here is scoped to the ACTIVE profile
 *  (docs/19-ACTIVE-PROFILE.md), greeting included. */
export default function HomePage() {
  const navigate = useNavigate();
  const { settings } = useSettingsStore();
  const { session } = useLiveSession();
  const profile = useActiveProfile();
  const [startOpen, setStartOpen] = useState(false);
  const [startActivity, setStartActivity] = useState<ContextPackKind>(DEFAULT_ACTIVITY);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const recent = sessions.slice(0, 4);
  const [micState, setMicState] = useState<'granted' | 'prompt' | 'denied' | 'unknown'>('unknown');
  const [activeSpace, setActiveSpace] = useState<string | null>(null);

  // Scoped to the active profile like every other profile surface
  // (docs/19-ACTIVE-PROFILE.md). This was the last unscoped read in the
  // dashboard: Home greets you by name and then listed someone else's calls
  // underneath it.
  useEffect(() => {
    if (!profile) {
      setSessions([]);
      return;
    }
    void api.session
      .list(profile.id)
      .then((all) => setSessions(all as SessionListItem[]))
      .catch(() => setSessions([]));
  }, [session, profile]);

  // Best-effort mic permission state (Chromium supports querying 'microphone').
  useEffect(() => {
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        setMicState(s.state as 'granted' | 'prompt' | 'denied');
        s.onchange = () => setMicState(s.state as 'granted' | 'prompt' | 'denied');
      })
      .catch(() => setMicState('unknown'));
  }, []);

  // The active Space = the live session's context pack.
  useEffect(() => {
    if (!session?.jobId) {
      setActiveSpace(null);
      return;
    }
    void api.jobs
      .get(session.jobId)
      .then((j) => {
        const job = j as Job;
        setActiveSpace(job.company || job.title || null);
      })
      .catch(() => setActiveSpace(null));
  }, [session]);

  // Named for what you would DO, not for the engine mode behind it — the same
  // vocabulary as the activity picker, so the roadmap and the product read as
  // one list rather than two.
  const labs = [
    { label: 'Interviewing someone', on: FLAGS.interviewerAssist, Icon: ClipboardCheckIcon },
    { label: 'Meetings & calls', on: FLAGS.meeting, Icon: UsersIcon },
    { label: 'Guided tutoring', on: FLAGS.tutor, Icon: GraduationCapIcon },
    { label: 'Games & solo work', on: FLAGS.companion, Icon: SparklesIcon },
    { label: 'Talk to BrainCue', on: FLAGS.voice, Icon: MicIcon },
  ].filter((l) => !l.on); // shipped ones graduate to real cards/actions below

  // Greeting the person by name is not decoration: it is the visible proof of
  // which profile the whole page is scoped to.
  return (
    <Page
      title={profile ? `Hi ${firstName(profile.name)}` : 'Welcome'}
      width="max-w-5xl"
    >
      {/* Live banner — mode-aware: interview/practice have a workspace to
          return to; ambient modes (meeting/companion) live in the Cue Card. */}
      {session &&
        (session.mode === 'meeting' || session.mode === 'companion' ? (
          <div className="mb-4 flex items-center justify-between rounded-2xl border border-green-500/20 bg-green-500/10 px-5 py-3.5">
            <span className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400" />
              </span>
              <span className="text-sm font-medium text-green-200">
                {/* What the user SAID it was. v1 rows carry no activity, and
                    the engine mode is not a name anyone chose — so they fall
                    back to the neutral sentence rather than to a mode name. */}
                {session.activity
                  ? `${activityConfig(session.activity).label} is live`
                  : 'A session is live'}
              </span>
            </span>
            <span className="text-sm text-green-300">Cards stream to the Cue Card</span>
          </div>
        ) : (
          <Link
            to="/interview"
            className="mb-4 flex items-center justify-between rounded-2xl border border-green-500/20 bg-green-500/10 px-5 py-3.5 transition-colors hover:bg-green-500/15"
          >
            <span className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400" />
              </span>
              <span className="text-sm font-medium text-green-200">A session is live</span>
            </span>
            <span className="text-sm text-green-300">Return to it →</span>
          </Link>
        ))}

      {/* What an interview still needs (transcription, an AI provider) — from
          main's readiness, so any keyed provider counts. Hidden once ready. */}
      <SetupChecklist />

      {/* ONE dominant action: the interview. */}
      <section
        data-tour="primary-actions"
        className="rounded-2xl border border-indigo-400/20 bg-gradient-to-br from-indigo-500/15 via-neutral-900/80 to-neutral-900/80 p-6 shadow-lg shadow-black/20"
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-50">
              <MicIcon className="h-5 w-5 text-indigo-300" />
              Interview Copilot
            </h2>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-neutral-300">
              Hears the interviewer and shows answers from your résumé and the job description, in a Cue
              Card only you can see.
            </p>
          </div>
          <button
            type="button"
            data-tour="action-start"
            onClick={() => {
              setStartActivity(DEFAULT_ACTIVITY);
              setStartOpen(true);
            }}
            className="shrink-0 rounded-xl bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow-md shadow-indigo-900/40 transition-all hover:bg-indigo-500 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300"
          >
            Start interview
          </button>
        </div>
      </section>

      {/* Secondary — deliberately small. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm" aria-label="Other tools">
        <SecondaryAction
          onClick={() => {
            // The last kind of other conversation this profile had, else a meeting.
            setStartActivity(lastOtherActivity(sessions));
            setStartOpen(true);
          }}
        >
          Other conversation
        </SecondaryAction>
        <SecondaryAction onClick={() => navigate('/mock')}>Practice</SecondaryAction>
        <SecondaryAction onClick={() => void api.capture.openSelector()}>Solve from screen</SecondaryAction>
        {FLAGS.voice && <SecondaryAction onClick={() => void api.voice.summon()}>Talk to BrainCue</SecondaryAction>}
      </div>

      {/* Recent activity */}
      {recent.length > 0 && (
        <>
          <h3 className="mb-3 mt-8 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Recent
          </h3>
          <div className="space-y-2">
            {recent.map((s) => (
              <Link
                key={s.id}
                to="/sessions"
                className="flex items-center justify-between rounded-xl border border-white/5 bg-neutral-900/60 px-4 py-2.5 transition-colors hover:bg-neutral-900"
              >
                <span className="min-w-0 truncate text-sm text-neutral-200">
                  {s.jobCompany || s.jobTitle || 'General session'}
                  <span className="ml-2 text-xs text-neutral-500">
                    {/* What the user SAID it was, not the mode we derived —
                        a project call and a standup both run 'meeting'. */}
                    {s.activity
                      ? activityConfig(s.activity).label.toLowerCase()
                      : s.mode === 'meeting'
                        ? 'meeting'
                        : s.mode === 'companion'
                          ? 'companion'
                          : s.interviewType.replace(/_/g, ' ')}
                    {s.kind === 'sparring' ? ' · practice' : ''}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {new Date(s.createdAt).toLocaleDateString()} · {fmtDur(durationMs(s))}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Everything that is not the interview — other activities, what it can
          see and hear, what is still in Labs — grouped away, one click. */}
      <details className="group mt-8 rounded-2xl border border-white/5 bg-neutral-900/40 px-4 py-3" data-tour="more-activities">
        <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-neutral-500 hover:text-neutral-300">
          More ways to use BrainCue
        </summary>
        <div className="pb-2">
          {/* Status row — what BrainCue can currently see/hear, at a glance. */}
          <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Capture status">
            <StatusChip
              label="Microphone"
              value={micState === 'unknown' ? '—' : micState}
              tone={micState === 'granted' ? 'ok' : micState === 'denied' ? 'warn' : 'idle'}
            />
            <StatusChip
              label="Hears"
              // A call is heard on both sides — the call and your microphone —
              // and questions come from the call. A solo session is your mic only.
              value={session?.mode === 'companion' ? 'microphone' : 'call + mic'}
              tone="idle"
            />
            <StatusChip label="Screen" value="on demand" tone="idle" />
            <StatusChip
              label="Memory"
              value={FLAGS.memory ? (settings?.memoryEnabled ? 'on' : 'off') : 'planned'}
              tone={FLAGS.memory && settings?.memoryEnabled ? 'ok' : 'idle'}
            />
            <StatusChip
              label="Active Space"
              value={session ? (activeSpace ?? 'profile only') : 'none'}
              tone={session ? 'ok' : 'idle'}
            />
          </div>

          {/* Shortcuts INTO the one start flow with an activity preselected —
              not a second catalog to choose from. */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {FLAGS.meeting && (
              <ActivityCard
                Icon={UsersIcon}
                title={ACTIVITIES.meeting.label}
                desc="Answers questions asked in the room, and surfaces context, action items and decisions — only when confident."
                labs
                tour="activity-meeting"
                onClick={() => {
                  setStartActivity('meeting');
                  setStartOpen(true);
                }}
              />
            )}
            {FLAGS.companion && (
              <ActivityCard
                Icon={SparklesIcon}
                title={`${ACTIVITIES.solo.label} · ${ACTIVITIES.game.label}`}
                desc="An ambient presence while you work or play — only through gates you control."
                labs
                tour="activity-companion"
                onClick={() => {
                  setStartActivity('solo');
                  setStartOpen(true);
                }}
              />
            )}
            <ActivityCard
              Icon={BoltIcon}
              title="Solve from screen"
              desc="Ctrl+Shift+S drag-selects a region; Ctrl+Shift+Enter solves what's on the clipboard — into the Cue Card."
              static
            />
          </div>

          {/* Labs — flag-gated modes graduate out of here when they ship. */}
          {labs.length > 0 && (
            <>
              <h3 className="mb-3 mt-6 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Labs · coming soon
              </h3>
              <div className="flex flex-wrap gap-2">
                {labs.map((l) => (
                  <span
                    key={l.label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-neutral-900/60 px-3 py-1.5 text-xs text-neutral-400"
                  >
                    <l.Icon className="h-3.5 w-3.5" />
                    {l.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </details>

      <StartSessionModal
        open={startOpen}
        onClose={() => setStartOpen(false)}
        initialActivity={startActivity}
      />
    </Page>
  );
}

function SecondaryAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-2.5 py-1.5 text-neutral-400 transition-colors hover:bg-neutral-800/70 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
    >
      {children}
    </button>
  );
}

function StatusChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'idle';
}) {
  const dot =
    tone === 'ok' ? 'bg-green-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-neutral-600';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-neutral-900/60 px-2.5 py-1 text-xs text-neutral-400">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}: <span className="text-neutral-300">{value}</span>
    </span>
  );
}

function ActivityCard({
  to,
  onClick,
  Icon,
  title,
  desc,
  tour,
  labs = false,
  static: isStatic = false,
  children,
}: {
  to?: string;
  onClick?: () => void;
  Icon: IconType;
  title: string;
  desc: string;
  tour?: string;
  /** Freshly shipped mode still collecting real-world hours. */
  labs?: boolean;
  /** Informational card — not a link (hotkey-driven feature). */
  static?: boolean;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
          <Icon className="h-5 w-5" />
        </span>
        {isStatic && <Badge tone="neutral">Hotkey</Badge>}
        {labs && <Badge tone="amber">Labs</Badge>}
      </div>
      <h4 className="mt-3 font-semibold text-neutral-100">{title}</h4>
      <p className="mt-1 text-sm leading-relaxed text-neutral-400">{desc}</p>
      {children}
    </>
  );
  const base = 'rounded-2xl border border-white/5 bg-neutral-900/70 p-5 shadow-lg shadow-black/20';
  const interactive =
    'transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-neutral-900';

  if (to) {
    return (
      <Link to={to} data-tour={tour} className={`${base} block ${interactive}`}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        data-tour={tour}
        onClick={onClick}
        className={`${base} block w-full text-left ${interactive} focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400`}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-tour={tour} className={base}>
      {body}
    </div>
  );
}

