import type React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Page } from '../../components/ui';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession } from '../../store/useLiveSession';
import {
  BoltIcon,
  ClipboardCheckIcon,
  GraduationCapIcon,
  MicIcon,
  MockIcon,
  SettingsIcon,
  SparklesIcon,
  UploadIcon,
  UsersIcon,
} from '../../components/icons';

type IconType = (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

/** The mode launcher (docs/11-UX-NAVIGATION.md §3.1): modes are content here,
 *  not sidebar chrome — a new mode adds a card, never a nav item. Cards link to
 *  the existing pages until the shared SessionView lands (step 3 of the
 *  redesign); planned modes render as visible teasers of where BrainCue is
 *  going. */
export default function HomePage() {
  const { settings } = useSettingsStore();
  const { session } = useLiveSession();

  return (
    <Page
      title="What are we doing?"
      subtitle="Pick a mode — BrainCue listens, grounds itself in your documents, and cues you in real time."
      width="max-w-5xl"
    >
      {session && (
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
      )}

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
        <ModeCard
          Icon={ClipboardCheckIcon}
          title="Interviewer Assist"
          desc="You're the one asking — question suggestions, coverage tracking, and an evaluation draft."
          planned
        />
        <ModeCard
          Icon={UsersIcon}
          title="Meeting Copilot"
          desc="Sits in your meeting and quietly surfaces context, unanswered questions, and action items."
          planned
        />
        <ModeCard
          Icon={GraduationCapIcon}
          title="Tutor"
          desc="Voice dialogue and drills grounded in any material you give it — a chapter, a codebase, a language."
          planned
        />
        <ModeCard
          Icon={SparklesIcon}
          title="Companion"
          desc="An ambient presence with memory while you work or game — speaks up only when it should."
          planned
        />
      </div>

      <h3 className="mb-3 mt-8 text-xs font-medium uppercase tracking-wider text-neutral-500">
        Tools
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ModeCard
          to="/tailor"
          Icon={UploadIcon}
          title="Tailor Resume"
          desc="Rewrite your résumé against a specific job's description."
          tour="tool-tailor"
        />
        <ModeCard
          Icon={BoltIcon}
          title="Solve from screen"
          desc="Ctrl+Shift+S drag-selects a region; Ctrl+Shift+Enter solves what's on the clipboard — anytime, into the Cue Card."
          static
        />
      </div>
    </Page>
  );
}

function ModeCard({
  to,
  Icon,
  title,
  desc,
  tour,
  planned = false,
  static: isStatic = false,
  children,
}: {
  to?: string;
  Icon: IconType;
  title: string;
  desc: string;
  tour?: string;
  planned?: boolean;
  /** Informational card — neither a link nor a teaser (no badge, full opacity). */
  static?: boolean;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${
            planned ? 'bg-white/5 text-neutral-500' : 'bg-indigo-500/10 text-indigo-300'
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        {planned && <Badge tone="neutral">Planned</Badge>}
      </div>
      <h4 className={`mt-3 font-semibold ${planned ? 'text-neutral-400' : 'text-neutral-100'}`}>
        {title}
      </h4>
      <p className="mt-1 text-sm leading-relaxed text-neutral-400">{desc}</p>
      {children}
    </>
  );
  const base = 'rounded-2xl border border-white/5 bg-neutral-900/70 p-5 shadow-lg shadow-black/20';

  if (to) {
    return (
      <Link
        to={to}
        data-tour={tour}
        className={`${base} block transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-neutral-900`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div data-tour={tour} className={`${base} ${planned ? 'opacity-70' : ''}`}>
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
