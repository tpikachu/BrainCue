import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession, type AudioSource, type Line } from '../../store/useLiveSession';
import type { AnswerStyle, InterviewType, Job, SessionDetail, SessionListItem } from '@shared/types';
import { Badge, Button, Card, Field, Page, Select, TextInput } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { JobFormModal } from '../JobFormModal';
import { Waveform } from '../../components/Waveform';
import { BoltIcon, FrameIcon, PauseIcon, PlayIcon, PlusIcon } from '../../components/icons';

const JOBS_PER_PAGE = 5;

const interviewTypes: InterviewType[] = [
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'product',
  'sales',
  'general',
];
const answerStyles: AnswerStyle[] = ['concise', 'detailed', 'star', 'technical', 'conversational'];

// Cap the number of transcript lines kept in the DOM. A long interview can produce
// thousands of lines; rendering them all bogs the page down. The full transcript is
// persisted and available in Reports — the live view just needs the recent tail.
const MAX_LINES = 400;

export default function SessionPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  // The live session lives in a global store so it survives navigating between
  // pages (and keeps the mic running). This page is just a view + controls.
  const live = useLiveSession();
  const { session, transcript, interim, paused } = live;

  const [profileId, setProfileId] = useState('');
  const [jobId, setJobId] = useState('');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  // Jobs table (server-paginated + searchable — never loads the full list).
  const [jobRows, setJobRows] = useState<Job[]>([]);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobQuery, setJobQuery] = useState('');
  const [jobPage, setJobPage] = useState(0);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editJob, setEditJob] = useState<Job | null>(null); // null => create

  const [interviewType, setInterviewType] = useState<InterviewType>('behavioral');
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>('concise');
  const [source, setSource] = useState<AudioSource>('system');

  const [ask, setAsk] = useState('');

  // The most recent past session for the selected profile+job, offered for resume.
  const [lastSession, setLastSession] = useState<SessionListItem | null>(null);
  const [resuming, setResuming] = useState(false);

  // Transcript auto-scroll: stick to the bottom for new lines, but pause when the
  // user scrolls up to read history (a "jump to latest" button re-enables it).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

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

  const selectJob = (job: Job) => {
    setJobId(job.id);
    setSelectedJob(job);
  };

  const openNew = () => {
    setEditJob(null);
    setFormOpen(true);
  };
  const openDetail = (job: Job) => {
    setEditJob(job);
    setFormOpen(true);
  };
  const onJobSaved = (job: Job) => {
    // Reflect the edit/create immediately and keep it selected.
    setSelectedJob(job);
    setJobId(job.id);
    void loadJobs();
  };
  const onJobDeleted = (id: string) => {
    if (jobId === id) {
      setJobId('');
      setSelectedJob(null);
    }
    void loadJobs();
  };

  // Find the most recent past round of THIS interview type for the selected job, to
  // offer "resume". Matching on type keeps e.g. behavioral and technical rounds as
  // separate sessions instead of collapsing them into one. Depends on `session` so
  // it RE-RUNS the moment a round ends — otherwise the setup view would still think
  // no round exists and you'd start a duplicate instead of being offered "resume".
  useEffect(() => {
    setLastSession(null);
    if (!profileId || !jobId || session) return; // skip while a round is live
    void (async () => {
      const all = (await api.session.list()) as SessionListItem[];
      const match = all.find(
        (s) => s.profileId === profileId && s.jobId === jobId && s.interviewType === interviewType,
      );
      setLastSession(match ?? null);
    })();
  }, [profileId, jobId, interviewType, session]);

  // Reset the selection + paging whenever the profile changes.
  useEffect(() => {
    setJobId('');
    setSelectedJob(null);
    setJobPage(0);
    setJobQuery('');
  }, [profileId]);

  // (Re)load the current page on profile/search/page change. The search is
  // debounced so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void loadJobs(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, jobQuery, jobPage]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const canStart =
    !!profileId && !!jobId && !!settings?.apiKeyPresent && !!selectedProfile?.parsedResume;

  // Columns for the jobs table. Kept here so the row actions can reach the page's
  // selection + modal handlers.
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
      header: 'Status',
      className: 'w-40',
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
      className: 'w-24 text-right',
      render: (j) => (
        <Button
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            openDetail(j);
          }}
        >
          Detail
        </Button>
      ),
    },
  ];

  const start = async () => {
    if (!canStart) return;
    setAtBottom(true);
    await live.startNew({ profileId, interviewType, answerStyle, jobId, source });
  };

  // Continue the most recent session for this job instead of creating a new row —
  // keeps Reports tidy and lets the AI build on the previous round's context.
  const resume = async () => {
    if (!lastSession) return;
    setResuming(true);
    try {
      const detail = (await api.session.get(lastSession.id)) as SessionDetail;
      const prior: Line[] = detail.transcript.map((c, i) => ({
        id: i,
        speaker: c.speaker,
        text: c.text,
      }));
      setAtBottom(true);
      await live.resumeExisting({
        sessionId: lastSession.id,
        interviewType,
        answerStyle,
        source,
        prior,
      });
    } finally {
      setResuming(false);
    }
  };

  const sendAsk = async () => {
    if (!session || !ask) return;
    await live.ask(ask);
    setAsk('');
  };

  // Keep the transcript pinned to the newest line, unless the user scrolled up.
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, interim, atBottom]);

  const onTranscriptScroll = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <Page
      title="Live Session"
      subtitle="Pick a profile and an interview (JD), choose this round’s type, then go live."
      actions={
        <div className="flex gap-2">
            <Button
              onClick={() => api.capture.quickSolve()}
              title="Copy the problem text, then click (or Ctrl+Shift+Enter)"
            >
              <BoltIcon /> Solve from clipboard
            </Button>
            <Button variant="ghost" onClick={() => api.capture.openSelector()} title="Ctrl+Shift+S">
              <FrameIcon /> Select region
            </Button>
          </div>
      }
    >
      {!session ? (
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

          {/* Interviews (jobs) — server-paginated, searchable table. Click a row to
              select it for this session; "Detail" opens the edit modal. */}
          {profileId && (
            <Card>
              <div className="mb-3">
                <h3 className="font-medium">Interview (job)</h3>
                <p className="mt-1 text-xs text-neutral-500">
                  Pick a saved interview to set up this round, or add a new one. Search by role or
                  client; most recent first.
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

          {/* This round */}
          {jobId && (
            <Card>
              <h3 className="mb-3 font-medium">This round</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Interview type" hint="intro, technical, panel, behavioral…">
                  <Select value={interviewType} onChange={(e) => setInterviewType(e.target.value as InterviewType)}>
                    {interviewTypes.map((t) => (
                      <option key={t} value={t}>
                        {t.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Answer style">
                  <Select value={answerStyle} onChange={(e) => setAnswerStyle(e.target.value as AnswerStyle)}>
                    {answerStyles.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Listen to"
                  hint={
                    source === 'system'
                      ? 'the interviewer’s voice from your speakers (online calls)'
                      : 'your microphone (in-person rooms)'
                  }
                >
                  <Select value={source} onChange={(e) => setSource(e.target.value as AudioSource)}>
                    <option value="system">Interviewer (system audio)</option>
                    <option value="mic">Microphone (in-person)</option>
                  </Select>
                </Field>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {lastSession && (
                  <Button variant="success" onClick={resume} disabled={!canStart} loading={resuming}>
                    <PlayIcon /> Resume {interviewType.replace('_', ' ')} round
                  </Button>
                )}
                <Button
                  variant={lastSession ? 'default' : 'success'}
                  onClick={start}
                  disabled={!canStart || resuming}
                >
                  {lastSession ? <><PlusIcon /> New round</> : <><PlayIcon /> Start session</>}
                </Button>
              </div>
              {lastSession ? (
                <p className="mt-2 text-xs text-neutral-500">
                  You already have a <strong>{interviewType.replace('_', ' ')}</strong> round for this
                  job — resume continues it (keeps Reports tidy and lets answers build on it). “New
                  round” starts a fresh one.
                </p>
              ) : (
                selectedJob && (
                  <p className="mt-2 text-xs text-neutral-500">
                    Answers will be grounded in your resume + “{selectedJob.title}”.
                  </p>
                )
              )}
            </Card>
          )}
        </div>
      ) : (
        <>
          <Card className="sticky top-0 z-10 mb-5 bg-neutral-900 ring-1 ring-white/5">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={live.speaking ? 'green' : live.stream ? 'blue' : 'neutral'}>
                {live.speaking ? '● speaking' : live.stream ? 'listening…' : 'live'}
              </Badge>
              {paused && <Badge tone="amber">paused</Badge>}
              <Button onClick={() => live.togglePause()}>
                {paused ? <><PlayIcon /> Resume AI</> : <><PauseIcon /> Pause AI</>}
              </Button>
              <Button variant="danger" onClick={() => void live.stop()}>
                Stop
              </Button>
              <span className="text-xs text-neutral-500">Answers stream to the Cue Card.</span>
            </div>
            {live.micError && <p className="mt-2 text-xs text-red-400">Mic error: {live.micError}</p>}
            {live.stream && (
              <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2">
                <Waveform stream={live.stream} className="h-12 w-full" />
              </div>
            )}
          </Card>

          <div className="mb-5 flex gap-2">
            <TextInput
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendAsk()}
              placeholder="Type a question to test grounded answering…"
            />
            <Button variant="primary" onClick={sendAsk}>
              Ask
            </Button>
          </div>

          <Card className="min-h-[220px]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-neutral-400">Transcript</h3>
              {transcript.length > MAX_LINES && (
                <span className="text-xs text-neutral-600">
                  showing last {MAX_LINES} of {transcript.length}
                </span>
              )}
            </div>
            {transcript.length === 0 && !interim ? (
              <p className="text-sm text-neutral-500">
                Transcript appears here as audio is transcribed. Answers stream to the Cue Card.
              </p>
            ) : (
              <div className="relative">
                <div
                  ref={scrollRef}
                  onScroll={onTranscriptScroll}
                  className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1 text-sm"
                >
                  {transcript.slice(-MAX_LINES).map((l) => (
                    <p key={l.id}>
                      <span className="text-neutral-500">{l.speaker}: </span>
                      {l.text}
                    </p>
                  ))}
                  {interim && (
                    <p className="italic text-neutral-500">
                      interviewer: {interim}
                      <span className="ml-0.5 animate-pulse">▋</span>
                    </p>
                  )}
                </div>
                {!atBottom && (
                  <button
                    type="button"
                    onClick={() => {
                      const el = scrollRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                      setAtBottom(true);
                    }}
                    className="absolute bottom-2 right-3 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-indigo-500"
                  >
                    ↓ Jump to latest
                  </button>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Create / edit an interview. `editJob` null => create mode. */}
      <JobFormModal
        open={formOpen}
        profileId={profileId}
        job={editJob}
        onClose={() => setFormOpen(false)}
        onSaved={onJobSaved}
        onDeleted={onJobDeleted}
      />
    </Page>
  );
}
