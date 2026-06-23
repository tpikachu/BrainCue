import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession, type AudioSource, type Line } from '../../store/useLiveSession';
import type { AnswerStyle, InterviewType, Job, SessionDetail, SessionListItem } from '@shared/types';
import { Badge, Button, Card, Field, Page, Select, TextArea, TextInput } from '../../components/ui';
import { Waveform } from '../../components/Waveform';
import {
  BoltIcon,
  FrameIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  UploadIcon,
} from '../../components/icons';

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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState('');
  const [newJob, setNewJob] = useState({ title: '', company: '', jdUrl: '', jdText: '', companyUrl: '' });
  const [showNewJob, setShowNewJob] = useState(false);
  const [savingJob, setSavingJob] = useState(false);
  const [fetchingJd, setFetchingJd] = useState(false);
  const [jdNotice, setJdNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

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

  const refreshJobs = async (pid: string) => setJobs((await api.jobs.list(pid)) as Job[]);

  // Find the most recent past round of THIS interview type for the selected job, to
  // offer "resume". Matching on type keeps e.g. behavioral and technical rounds as
  // separate sessions instead of collapsing them into one.
  useEffect(() => {
    setLastSession(null);
    if (!profileId || !jobId) return;
    void (async () => {
      const all = (await api.session.list()) as SessionListItem[];
      const match = all.find(
        (s) => s.profileId === profileId && s.jobId === jobId && s.interviewType === interviewType,
      );
      setLastSession(match ?? null);
    })();
  }, [profileId, jobId, interviewType]);

  useEffect(() => {
    setJobId('');
    setShowNewJob(false);
    if (!profileId) {
      setJobs([]);
      return;
    }
    void refreshJobs(profileId);
  }, [profileId]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const selectedJob = jobs.find((j) => j.id === jobId);
  const canStart =
    !!profileId && !!jobId && !!settings?.apiKeyPresent && !!selectedProfile?.parsedResume;

  const saveJob = async () => {
    if (!profileId || (!newJob.title.trim() && !newJob.jdText.trim())) return;
    setSavingJob(true);
    setSaveNotice(null);
    try {
      const res = await api.jobs.save({
        profileId,
        title: newJob.title.trim() || 'Untitled role',
        company: newJob.company.trim() || null,
        jdUrl: newJob.jdUrl.trim() || null,
        jdText: newJob.jdText.trim() || null,
        companyUrl: newJob.companyUrl.trim() || null,
      });
      await refreshJobs(profileId);
      setJobId((res.job as Job).id);
      setNewJob({ title: '', company: '', jdUrl: '', jdText: '', companyUrl: '' });
      setJdNotice(null);
      setShowNewJob(false);
      // Surface the outcome of the (best-effort) company research.
      if (res.companyError) {
        setSaveNotice({
          tone: 'err',
          text: `Interview saved, but company research failed: ${res.companyError}`,
        });
      } else if (res.companyResearched) {
        setSaveNotice({ tone: 'ok', text: 'Interview saved & company researched ✓' });
      }
    } finally {
      setSavingJob(false);
    }
  };

  const uploadJd = async () => {
    const { filePath } = await api.dialog.openFile();
    if (!filePath) return;
    const { text } = await api.documents.extractFile(filePath);
    setNewJob((j) => ({ ...j, jdText: text }));
  };

  // Best-effort: pull the JD text from the pasted link into the text box. Job
  // sites that block bots or render client-side will fail — the user can then
  // paste the description manually.
  const fetchJd = async () => {
    const url = newJob.jdUrl.trim();
    if (!url) return;
    setFetchingJd(true);
    setJdNotice(null);
    try {
      const { text, title } = await api.documents.fetchUrl(url);
      setNewJob((j) => ({ ...j, jdText: text, title: j.title || title || '' }));
      setJdNotice({ tone: 'ok', text: 'Fetched the page text — review & trim it below, then Save.' });
    } catch (e) {
      setJdNotice({
        tone: 'err',
        text: `${(e as Error).message} Please paste the job description below so it can be parsed precisely.`,
      });
    } finally {
      setFetchingJd(false);
    }
  };

  const deleteJob = async (id: string) => {
    await api.jobs.delete(id);
    if (jobId === id) setJobId('');
    await refreshJobs(profileId);
  };

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

          {/* Interviews (jobs) */}
          {profileId && (
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium">Interview (job)</h3>
                <Button variant="ghost" onClick={() => setShowNewJob((v) => !v)}>
                  {showNewJob ? 'Cancel' : <><PlusIcon /> New interview</>}
                </Button>
              </div>

              {jobs.length === 0 && !showNewJob && (
                <p className="text-sm text-neutral-500">
                  No interviews yet. Create one with a job description — it’s saved and reused for
                  every round of that job.
                </p>
              )}

              {jobs.length > 0 && (
                <div className="space-y-2">
                  {jobs.map((j) => (
                    <label
                      key={j.id}
                      className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                        jobId === j.id
                          ? 'border-indigo-500 bg-indigo-500/10'
                          : 'border-neutral-800 bg-neutral-950/50 hover:border-neutral-700'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="job"
                          checked={jobId === j.id}
                          onChange={() => setJobId(j.id)}
                          className="accent-indigo-500"
                        />
                        <div>
                          <div className="font-medium">
                            {j.title || 'Untitled role'}
                            {j.company ? ` · ${j.company}` : ''}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            {j.parsedJd ? (
                              <Badge tone="green">JD parsed ✓</Badge>
                            ) : (
                              <Badge tone="amber">no JD</Badge>
                            )}
                            {j.parsedCompany && <Badge tone="blue">company ✓</Badge>}
                            {j.jdUrl && (
                              <a
                                href={j.jdUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="truncate text-xs text-indigo-300 hover:underline"
                                title={j.jdUrl}
                              >
                                🔗 posting
                              </a>
                            )}
                            {j.companyUrl && (
                              <a
                                href={j.companyUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="truncate text-xs text-indigo-300 hover:underline"
                                title={j.companyUrl}
                              >
                                🏢 site
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          void deleteJob(j.id);
                        }}
                        className="text-xs text-red-300 hover:text-red-200"
                      >
                        delete
                      </button>
                    </label>
                  ))}
                </div>
              )}

              {showNewJob && (
                <div className="mt-3 space-y-3 rounded-lg border border-neutral-800 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Interview name / role">
                      <TextInput
                        value={newJob.title}
                        onChange={(e) => setNewJob((j) => ({ ...j, title: e.target.value }))}
                        placeholder="e.g. Acme — Senior PM"
                      />
                    </Field>
                    <Field label="Company">
                      <TextInput
                        value={newJob.company}
                        onChange={(e) => setNewJob((j) => ({ ...j, company: e.target.value }))}
                        placeholder="e.g. Acme"
                      />
                    </Field>
                  </div>
                  <Field
                    label="JD link (optional)"
                    hint="Paste the job-posting URL — we’ll try to pull the description in. Some sites block this; you can always paste below."
                  >
                    <div className="flex gap-2">
                      <TextInput
                        type="url"
                        value={newJob.jdUrl}
                        onChange={(e) => setNewJob((j) => ({ ...j, jdUrl: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && fetchJd()}
                        placeholder="https://company.com/careers/123"
                        className="flex-1"
                      />
                      <Button
                        variant="default"
                        onClick={fetchJd}
                        loading={fetchingJd}
                        disabled={!newJob.jdUrl.trim()}
                      >
                        Fetch
                      </Button>
                    </div>
                  </Field>
                  {jdNotice && (
                    <p
                      className={`text-xs ${jdNotice.tone === 'err' ? 'text-amber-400' : 'text-green-400'}`}
                    >
                      {jdNotice.text}
                    </p>
                  )}
                  <Button variant="default" onClick={uploadJd}>
                    <UploadIcon /> Upload JD file
                  </Button>
                  <Field label="Job description (parsed for grounding)">
                    <TextArea
                      rows={6}
                      value={newJob.jdText}
                      onChange={(e) => setNewJob((j) => ({ ...j, jdText: e.target.value }))}
                      placeholder="Paste the job description"
                    />
                  </Field>
                  <Field
                    label="Company website (optional)"
                    hint="On save we’ll research the site (about, careers, …) so answers can speak to the company’s products, values & culture. Needs an OpenAI key."
                  >
                    <TextInput
                      type="url"
                      value={newJob.companyUrl}
                      onChange={(e) => setNewJob((j) => ({ ...j, companyUrl: e.target.value }))}
                      placeholder="https://company.com"
                    />
                  </Field>
                  {saveNotice && (
                    <p
                      className={`text-xs ${saveNotice.tone === 'err' ? 'text-amber-400' : 'text-green-400'}`}
                    >
                      {saveNotice.text}
                    </p>
                  )}
                  <Button variant="primary" onClick={saveJob} loading={savingJob}>
                    {newJob.companyUrl.trim() ? 'Save & research' : 'Save interview'}
                  </Button>
                </div>
              )}
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
    </Page>
  );
}
