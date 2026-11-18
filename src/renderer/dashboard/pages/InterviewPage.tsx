import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useActiveProfile } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession } from '../../store/useLiveSession';
import { useReadiness } from '../../store/useReadiness';
import type { Job, SessionListItem } from '@shared/types';
import { Badge, Button, Card, Page } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { JobFormModal } from '../JobFormModal';
import { BriefModal } from '../BriefModal';
import { SampleQuestions } from '../SampleQuestions';
import { StartSessionModal } from '../StartSessionModal';
import { isResumableInterview, startBlocker } from '../startFlow';
import { PlayIcon, PlusIcon } from '../../components/icons';

const JOBS_PER_PAGE = 5;

export default function InterviewPage() {
  const { load: loadSettings } = useSettingsStore();
  // The live session lives in a global store so it survives navigating between
  // pages (and keeps the mic running). This page registers/selects interviews and
  // starts them; the live surface — transcript, answers, and all the round controls
  // (type, format, length, device) — lives in the floating Cue Card.
  const live = useLiveSession();
  const { session } = live;

  // Whose interview this is was decided in the sidebar switcher.
  const selectedProfile = useActiveProfile();
  const profileId = selectedProfile?.id ?? '';
  const [jobId, setJobId] = useState(''); // selected row (for highlight)

  // Jobs table (server-paginated + searchable — never loads the full list).
  const [jobRows, setJobRows] = useState<Job[]>([]);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobQuery, setJobQuery] = useState('');
  const [jobPage, setJobPage] = useState(0);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editJob, setEditJob] = useState<Job | null>(null); // null => create
  const [briefJob, setBriefJob] = useState<Job | null>(null); // open => prep-brief modal

  // Latest session per job, so each row offers Start (none yet) or Resume.
  const [sessionsByJob, setSessionsByJob] = useState<Map<string, SessionListItem>>(new Map());
  // A new round starts — and a saved one resumes — through the ONE start
  // flow (its setup rows and consent summary), with this role already chosen.
  const [startFor, setStartFor] = useState<string | null>(null);
  const [resumeFor, setResumeFor] = useState<SessionListItem | null>(null);
  const readiness = useReadiness();

  // The save-or-discard prompt itself is GLOBAL (SavePromptModal in App) — here we
  // only watch it so the table's Start/Resume buttons refresh after save/discard.
  const { pendingSave } = live;

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Fetch the current page of jobs. Server-paginated + searchable, so we never
  // load the whole list — stays fast even with thousands of jobs.
  const loadJobs = async () => {
    if (!profileId) {
      setJobRows([]);
      setJobTotal(0);
      return;
    }
    setJobsLoading(true);
    try {
      // Interviews only — a standup or a study Space is not a role, and
      // filtering server-side keeps the paging and the count exact.
      const { items, total } = await api.jobs.page(
        profileId,
        jobQuery.trim(),
        JOBS_PER_PAGE,
        jobPage * JOBS_PER_PAGE,
        'job',
      );
      setJobRows(items as Job[]);
      setJobTotal(total);
    } finally {
      setJobsLoading(false);
    }
  };

  // Map each job → its most recent session (for Start vs Resume on the row).
  // Re-runs when a session starts/stops so the row buttons stay correct.
  useEffect(() => {
    if (!profileId) {
      setSessionsByJob(new Map());
      return;
    }
    void (async () => {
      const all = (await api.session.list(profileId)) as SessionListItem[];
      const map = new Map<string, SessionListItem>();
      for (const s of all) {
        // Only real interviews drive Start/Resume — never a meeting, a
        // companion session, a mock interview or a sparring drill.
        if (!isResumableInterview(s) || !s.jobId) continue;
        if (!map.has(s.jobId)) map.set(s.jobId, s); // list is newest-first
      }
      setSessionsByJob(map);
    })();
  }, [profileId, session, pendingSave]);

  // Reset the selection + paging whenever the profile changes.
  useEffect(() => {
    setJobId('');
    setJobPage(0);
    setJobQuery('');
  }, [profileId]);

  // (Re)load the current page on profile/search/page change (search debounced).
  useEffect(() => {
    const t = setTimeout(() => void loadJobs(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, jobQuery, jobPage]);

  // Can a round start or resume at all? The same gate as the start flow —
  // main's readiness (any provider with a key; on-device transcription needs
  // none) and a read résumé. The role is the row itself, so it is not asked.
  // `blocker` is the one line above the table; Start and Resume both open the
  // start flow, which shows each gap on its own row before anything starts.
  const blocker = !readiness
    ? 'Checking setup…'
    : startBlocker({
        profile: selectedProfile,
        chatReady: readiness.chat.ready,
        chatProblem: readiness.chat.problem,
        sttReady: readiness.transcription.ready,
        sttProblem: readiness.transcription.problem,
        sessionLive: false,
        activity: 'job',
        spaceId: 'row',
      });
  const fixRoute = !readiness
    ? null
    : !readiness.chat.ready
      ? '/settings/models'
      : !readiness.transcription.ready
        ? '/settings/speech'
        : selectedProfile
          ? `/profiles/${selectedProfile.id}`
          : '/profiles';

  const selectJob = (job: Job) => setJobId(job.id);
  const openNew = () => {
    setEditJob(null);
    setFormOpen(true);
  };
  const openDetail = (job: Job) => {
    setEditJob(job);
    setFormOpen(true);
  };
  const onJobSaved = (job: Job) => {
    setJobId(job.id);
    void loadJobs();
  };
  const onJobDeleted = (id: string) => {
    if (jobId === id) setJobId('');
    void loadJobs();
  };

  // A new round goes through the start flow — the same setup rows and consent
  // summary as Home, with this role chosen — never a second, silent Start.
  const start = (job: Job) => {
    if (session) return;
    setJobId(job.id);
    setStartFor(job.id);
  };

  // Continue the existing session for this interview — through the start
  // flow, which shows setup, readiness and what is sent before capturing.
  const resume = (sess: SessionListItem) => {
    if (session) return;
    setResumeFor(sess);
  };

  const jobColumns: Column<Job>[] = [
    {
      key: 'title',
      header: 'Interview',
      render: (j) => (
        <div>
          <div className="font-medium text-neutral-100">{j.title || 'Untitled role'}</div>
          {j.company && <div className="text-xs text-neutral-500">{j.company}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'JD',
      className: 'w-32',
      render: (j) => (
        <div className="flex flex-wrap gap-1.5">
          {j.parsedJd ? <Badge tone="green">JD ✓</Badge> : <Badge tone="amber">no JD</Badge>}
          {j.parsedCompany && <Badge tone="blue">company ✓</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-72 text-right',
      render: (j) => {
        const isLive = !!session && session.jobId === j.id;
        const prior = sessionsByJob.get(j.id);
        return (
          <div
            className="flex items-center justify-end gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {isLive ? (
              <>
                <Badge tone="green">● live</Badge>
                <Button variant="danger" onClick={() => void live.stop()}>
                  Stop
                </Button>
              </>
            ) : prior ? (
              <Button
                variant="success"
                disabled={!!session}
                onClick={() => resume(prior)}
              >
                <PlayIcon /> Resume
              </Button>
            ) : (
              <Button variant="success" disabled={!!session} onClick={() => start(j)}>
                <PlayIcon /> Start
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!j.parsedJd}
              title={j.parsedJd ? 'Pre-interview prep brief' : 'Add a job description first'}
              onClick={() => setBriefJob(j)}
            >
              Brief
            </Button>
            <Button variant="ghost" onClick={() => openDetail(j)}>
              Detail
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <Page title="Interviews" subtitle="Your roles. Start a round or resume one — cues appear in the Cue Card.">
      {(live.micError || live.sessionError) && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>
            <strong className="font-semibold">
              {live.micError ? 'Audio capture failed' : 'Session error'}:
            </strong>{' '}
            {live.micError || live.sessionError}
            {live.sessionError && session && (
              <span className="text-red-300/70">
                {' '}
                — the interview may have stopped transcribing. Stop and start again if needed.
              </span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {live.sessionError && session && (
              <Button variant="danger" onClick={() => void live.stop()}>
                Stop
              </Button>
            )}
            <button
              onClick={() => (live.micError ? live.clearMicError() : live.clearSessionError())}
              className="rounded p-0.5 text-red-300/70 hover:text-red-200"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {session && (
        <p className="mb-4 text-xs text-neutral-500">
          ● An interview is live — transcript, answers, and all controls are in the floating Cue
          Card. Stop it from there or here.
        </p>
      )}

      <div className="space-y-5">
        {/* What stops a round starting, once, with its fix. */}
        {profileId && blocker && readiness && (
          <p className="text-xs text-amber-400" role="status">
            ⚠ {blocker}{' '}
            {fixRoute && (
              <Link to={fixRoute} className="underline">
                Fix
              </Link>
            )}
          </p>
        )}

        {/* Interviews (jobs) — paginated, searchable. Start/Resume per row; the
            round's type/format/length are chosen live in the Cue Card. */}
        {profileId && (
          <Card>

            <DataTable<Job>
              columns={jobColumns}
              rows={jobRows}
              rowKey={(j) => j.id}
              total={jobTotal}
              page={jobPage}
              pageSize={JOBS_PER_PAGE}
              onPage={setJobPage}
              query={jobQuery}
              onQuery={(q) => {
                setJobQuery(q);
                setJobPage(0);
              }}
              searchPlaceholder="Search interviews by role or client…"
              onRowClick={selectJob}
              isSelected={(j) => j.id === jobId}
              loading={jobsLoading}
              empty="No roles yet. Add one with its job description — it is reused for every round."
              actions={
                <Button variant="primary" onClick={openNew}>
                  <PlusIcon /> New role
                </Button>
              }
            />
          </Card>
        )}

        {/* Solo testing aid: play a sample interviewer question aloud. */}
        {profileId && <SampleQuestions />}
      </div>

      {/* Create / edit an interview. `editJob` null => create mode. */}
      <JobFormModal
        open={formOpen}
        profileId={profileId}
        job={editJob}
        initialKind="job"
        lockKind
        onClose={() => setFormOpen(false)}
        onSaved={onJobSaved}
        onDeleted={onJobDeleted}
      />

      <StartSessionModal open={!!startFor} onClose={() => setStartFor(null)} initialSpaceId={startFor ?? undefined} />
      <StartSessionModal open={!!resumeFor} onClose={() => setResumeFor(null)} resume={resumeFor ?? undefined} />

      {/* Pre-interview prep brief (résumé × JD × company), generated on open. */}
      <BriefModal open={!!briefJob} job={briefJob} onClose={() => setBriefJob(null)} />
    </Page>
  );
}
