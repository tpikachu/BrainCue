import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession, type Line } from '../../store/useLiveSession';
import type { Job, SessionDetail, SessionListItem } from '@shared/types';
import { Badge, Button, Card, Field, Page, Select } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { JobFormModal } from '../JobFormModal';
import { BriefModal } from '../BriefModal';
import { SampleQuestions } from '../SampleQuestions';
import { PlayIcon, PlusIcon } from '../../components/icons';

const JOBS_PER_PAGE = 5;

export default function InterviewPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  // The live session lives in a global store so it survives navigating between
  // pages (and keeps the mic running). This page registers/selects interviews and
  // starts them; the live surface — transcript, answers, and all the round controls
  // (type, format, length, device) — lives in the floating Cue Card.
  const live = useLiveSession();
  const { session } = live;

  const [profileId, setProfileId] = useState('');
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
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  // The save-or-discard prompt itself is GLOBAL (SavePromptModal in App) — here we
  // only watch it so the table's Start/Resume buttons refresh after save/discard.
  const { pendingSave } = live;

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

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
      const { items, total } = await api.jobs.page(
        profileId,
        jobQuery.trim(),
        JOBS_PER_PAGE,
        jobPage * JOBS_PER_PAGE,
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
      const all = (await api.session.list()) as SessionListItem[];
      const map = new Map<string, SessionListItem>();
      for (const s of all) {
        if (s.profileId !== profileId || !s.jobId) continue;
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

  const selectedProfile = profiles.find((p) => p.id === profileId);
  // Can a round start at all (profile + key + parsed resume). Per-row Start also
  // requires no other session to be live (single live session at a time).
  const canStartBase = !!profileId && !!settings?.apiKeyPresent && !!selectedProfile?.parsedResume;

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

  const audioPrefs = () => settings?.audio ?? { source: 'system' as const, micDeviceId: null };

  // Start a brand-new session for an interview. Type/format/length use defaults
  // and are adjusted live in the Cue Card; the audio device comes from settings.
  const start = async (job: Job) => {
    if (!canStartBase || session) return;
    setJobId(job.id);
    setBusyJobId(job.id);
    try {
      const a = audioPrefs();
      await live.startNew({
        profileId,
        jobId: job.id,
        interviewType: 'general',
        answerFormat: 'key_points',
        source: a.source,
        micDeviceId: a.micDeviceId,
      });
    } finally {
      setBusyJobId(null);
    }
  };

  // Continue the existing session for this interview (reloads its transcript).
  const resume = async (sess: SessionListItem) => {
    if (!canStartBase || session) return;
    setBusyJobId(sess.jobId);
    try {
      const detail = (await api.session.get(sess.id)) as SessionDetail;
      const prior: Line[] = detail.transcript.map((c, i) => ({
        id: i,
        speaker: c.speaker,
        text: c.text,
      }));
      const a = audioPrefs();
      await live.resumeExisting({
        sessionId: sess.id,
        source: a.source,
        micDeviceId: a.micDeviceId,
        prior,
      });
    } finally {
      setBusyJobId(null);
    }
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
                disabled={!canStartBase || !!session}
                loading={busyJobId === j.id}
                onClick={() => resume(prior)}
              >
                <PlayIcon /> Resume
              </Button>
            ) : (
              <Button
                variant="success"
                disabled={!canStartBase || !!session}
                loading={busyJobId === j.id}
                onClick={() => start(j)}
              >
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
    <Page
      title="Interview"
      subtitle="Pick a profile and an interview, then Start — your live cues appear in the Cue Card."
    >
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
        {/* Profile */}
        <Card>
          <Field label="Profile">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Select a profile…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.targetRole ? ` · ${p.targetRole}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          {selectedProfile && !selectedProfile.parsedResume && (
            <p className="mt-2 text-xs text-amber-400">
              ⚠ This profile has no parsed resume —{' '}
              <Link to={`/profiles/${selectedProfile.id}`} className="underline">
                add & parse a resume
              </Link>
              .
            </p>
          )}
          {!settings?.apiKeyPresent && (
            <p className="mt-2 text-xs text-amber-400">
              ⚠ No OpenAI key —{' '}
              <Link to="/settings" className="underline">
                add it in Settings
              </Link>
              .
            </p>
          )}
        </Card>

        {/* Interviews (jobs) — paginated, searchable. Start/Resume per row; the
            round's type/format/length are chosen live in the Cue Card. */}
        {profileId && (
          <Card>
            <div className="mb-3">
              <h3 className="font-medium">Interviews</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Pick an interview and press <strong>Start</strong> — or <strong>Resume</strong> to
                continue a previous one. Interview type, answer format &amp; length are set live in
                the Cue Card.
              </p>
            </div>

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
              empty="No interviews yet. Add one with a job description — it’s saved and reused for every round of that job."
              actions={
                <Button variant="primary" onClick={openNew}>
                  <PlusIcon /> New interview
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
        onClose={() => setFormOpen(false)}
        onSaved={onJobSaved}
        onDeleted={onJobDeleted}
      />

      {/* Pre-interview prep brief (résumé × JD × company), generated on open. */}
      <BriefModal open={!!briefJob} job={briefJob} onClose={() => setBriefJob(null)} />
    </Page>
  );
}
