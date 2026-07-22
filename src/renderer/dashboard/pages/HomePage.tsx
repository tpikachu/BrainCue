import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { FLAGS } from '@shared/flags';
import type { Job, SessionListItem } from '@shared/types';
import { Badge, Page } from '../../components/ui';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession } from '../../store/useLiveSession';
import { StartSessionModal } from '../StartSessionModal';
import { durationMs, fmtDur } from '../../lib/format';
import {
  BoltIcon,
  ClipboardCheckIcon,
  FrameIcon,
  GraduationCapIcon,
  LibraryIcon,
  MicIcon,
  MockIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from '../../components/icons';

type IconType = (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

/** Home (docs/11-UX-NAVIGATION.md): one companion, not an interview app with
 *  disabled cards. Primary actions up top, an honest permission/status row,
 *  recent activity, and the mode cards as secondary presets. Planned modes are
 *  flag-gated into a compact Labs strip — never dead-looking cards. */
export default function HomePage() {
  const navigate = useNavigate();
  const { settings } = useSettingsStore();
  const { session } = useLiveSession();
  const [startOpen, setStartOpen] = useState(false);
  const [startMode, setStartMode] = useState<'interview' | 'meeting' | 'companion'>('interview');
  const [recent, setRecent] = useState<SessionListItem[]>([]);
  const [micState, setMicState] = useState<'granted' | 'prompt' | 'denied' | 'unknown'>('unknown');
  const [activeSpace, setActiveSpace] = useState<string | null>(null);

  useEffect(() => {
    void api.session
      .list()
      .then((all) => setRecent((all as SessionListItem[]).slice(0, 4)))
      .catch(() => setRecent([]));
  }, [session]);

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

  const labs = [
    { label: 'Interviewer Assist', on: FLAGS.interviewerAssist, Icon: ClipboardCheckIcon },
    { label: 'Meeting Copilot', on: FLAGS.meeting, Icon: UsersIcon },
    { label: 'Tutor', on: FLAGS.tutor, Icon: GraduationCapIcon },
    { label: 'Companion', on: FLAGS.companion, Icon: SparklesIcon },
    { label: 'Talk to BrainCue', on: FLAGS.voice, Icon: MicIcon },
  ].filter((l) => !l.on); // shipped ones graduate to real cards/actions below

  return (
    <Page
      title="How can BrainCue help right now?"
      subtitle="It listens, grounds itself in your documents, and cues you in real time."
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
                {session.mode === 'meeting' ? 'Meeting Copilot is live' : 'Companion is live'}
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

      {settings && !settings.apiKeyPresent && (
        <Link
          to="/settings"
          className="mb-4 flex items-center justify-between rounded-2xl border border-amber-500/20 bg-amber-500/10 px-5 py-3.5 transition-colors hover:bg-amber-500/15"
        >
          <span className="flex items-center gap-3 text-sm text-amber-200">
            <SettingsIcon className="h-4 w-4" />
            Add your OpenAI API key to unlock every mode.
          </span>
          <span className="text-sm text-amber-300">Open Settings →</span>
        </Link>
      )}

      {/* Primary actions. "Talk to BrainCue" joined when voice shipped
          (FLAGS.voice) — a summon starts push-to-talk listening in the Cue
          Card, with or without a session. */}
      <div
        className={`grid grid-cols-1 gap-3 ${FLAGS.voice ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}
        data-tour="primary-actions"
      >
        <PrimaryAction
          Icon={MicIcon}
          title="Start listening"
          desc="Live cues for the conversation you're in"
          onClick={() => {
            setStartMode('interview');
            setStartOpen(true);
          }}
          tour="action-start"
        />
        {FLAGS.voice && (
          <PrimaryAction
            Icon={SparklesIcon}
            title="Talk to BrainCue"
            desc="Push-to-talk: ask by voice, hear the answer"
            onClick={() => void api.voice.summon()}
          />
        )}
        <PrimaryAction
          Icon={FrameIcon}
          title="Share screen"
          desc="Capture a region — the answer streams to the Cue Card"
          onClick={() => void api.capture.openSelector()}
        />
        <PrimaryAction
          Icon={LibraryIcon}
          title="Add context"
          desc="Create a Space with a JD, docs, or notes"
          onClick={() => navigate('/library?tab=spaces')}
        />
      </div>

      {/* Status row — what BrainCue can currently see/hear, at a glance. */}
      <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Capture status">
        <StatusChip
          label="Microphone"
          value={micState === 'unknown' ? '—' : micState}
          tone={micState === 'granted' ? 'ok' : micState === 'denied' ? 'warn' : 'idle'}
        />
        <StatusChip
          label="Listening to"
          // Companion always listens to YOUR mic, whatever the saved default.
          value={
            session?.mode === 'companion'
              ? 'microphone'
              : settings?.audio?.source === 'mic'
                ? 'microphone'
                : 'system audio'
          }
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
                    {s.mode === 'meeting'
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

      {/* Modes — secondary presets. */}
      <h3 className="mb-3 mt-8 text-xs font-medium uppercase tracking-wider text-neutral-500">
        Modes
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ModeCard
          to="/interview"
          Icon={MicIcon}
          title="Interview Copilot"
          desc="You're the candidate. BrainCue hears the questions and streams grounded answer cues into the Cue Card."
          tour="mode-interview"
        />
        <ModeCard
          Icon={MockIcon}
          title="Practice"
          desc="Rehearse out loud: an AI interviewer asks with a voice, and every answer gets coached."
          tour="mode-practice"
        >
          <div className="mt-3 flex gap-2">
            <PracticeLink to="/mock" label="Mock interview" />
            <PracticeLink to="/sparring" label="Sparring drill" />
          </div>
        </ModeCard>
        {FLAGS.meeting && (
          <ModeCard
            Icon={UsersIcon}
            title="Meeting Copilot"
            desc="Sits in quietly and surfaces context, open questions, action items, and decisions — only when confident."
            labs
            tour="mode-meeting"
            onClick={() => {
              setStartMode('meeting');
              setStartOpen(true);
            }}
          />
        )}
        {FLAGS.companion && (
          <ModeCard
            Icon={SparklesIcon}
            title="Companion"
            desc="An ambient presence while you work: remembers what you saved, flags tasks, offers context — only through deterministic gates you control."
            labs
            tour="mode-companion"
            onClick={() => {
              setStartMode('companion');
              setStartOpen(true);
            }}
          />
        )}
        <ModeCard
          Icon={BoltIcon}
          title="Solve from screen"
          desc="Ctrl+Shift+S drag-selects a region; Ctrl+Shift+Enter solves what's on the clipboard — anytime, into the Cue Card."
          static
        />
      </div>

      {/* Labs — flag-gated modes graduate out of here when they ship. */}
      {labs.length > 0 && (
        <>
          <h3 className="mb-3 mt-8 text-xs font-medium uppercase tracking-wider text-neutral-500">
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

      <StartSessionModal
        open={startOpen}
        onClose={() => setStartOpen(false)}
        initialMode={startMode}
      />
    </Page>
  );
}

function PrimaryAction({
  Icon,
  title,
  desc,
  onClick,
  tour,
}: {
  Icon: IconType;
  title: string;
  desc: string;
  onClick: () => void;
  tour?: string;
}) {
  return (
    <button
      type="button"
      data-tour={tour}
      onClick={onClick}
      className="rounded-2xl border border-white/5 bg-neutral-900/70 p-5 text-left shadow-lg shadow-black/20 transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
        <Icon className="h-5 w-5" />
      </span>
      <span className="mt-3 block font-semibold text-neutral-100">{title}</span>
      <span className="mt-1 block text-sm leading-relaxed text-neutral-400">{desc}</span>
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

function ModeCard({
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

function PracticeLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 ring-1 ring-white/5 transition-colors hover:bg-neutral-700"
    >
      {label}
    </Link>
  );
}
