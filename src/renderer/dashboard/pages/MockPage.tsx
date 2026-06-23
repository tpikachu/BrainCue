import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAnswerRecorder } from '../../lib/useAnswerRecorder';
import type { InterviewType, Job, SessionReport } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Page, Select, TextArea } from '../../components/ui';
import { MicIcon, PlayIcon } from '../../components/icons';

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const INTERVIEW_TYPES: InterviewType[] = [
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'product',
  'sales',
  'general',
];

interface Turn {
  role: 'interviewer' | 'you';
  text: string;
}

export default function MockPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const rec = useAnswerRecorder();

  const [profileId, setProfileId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [interviewType, setInterviewType] = useState<InterviewType>('behavioral');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

  useEffect(() => {
    setJobId('');
    if (!profileId) {
      setJobs([]);
      return;
    }
    void (async () => setJobs((await api.jobs.list(profileId)) as Job[]))();
  }, [profileId]);

  const play = (base64: string) => {
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: 'audio/mpeg',
    });
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = url;
    void audioRef.current.play().catch(() => {});
  };

  const start = async () => {
    if (!profileId) return;
    if (!settings?.apiKeyPresent) {
      alert('Add your OpenAI API key in Settings first.');
      return;
    }
    setBusy('Starting interview & generating first question…');
    setReport(null);
    setTurns([]);
    try {
      const r = await api.mock.start(profileId, voice, jobId || null, interviewType);
      setSessionId(r.session.id);
      setQuestion(r.question);
      setProgress({ index: r.index, total: r.total });
      setTurns([{ role: 'interviewer', text: r.question }]);
      play(r.audioBase64);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleResult = (
    r: { done: boolean; index: number; total: number; question?: string; audioBase64?: string },
    answer: string,
  ) => {
    setTurns((t) => [...t, { role: 'you', text: answer }]);
    if (r.done || !r.question) {
      void finish();
      return;
    }
    setQuestion(r.question);
    setProgress({ index: r.index, total: r.total });
    setTurns((t) => [...t, { role: 'interviewer', text: r.question! }]);
    if (r.audioBase64) play(r.audioBase64);
  };

  const submitTyped = async () => {
    if (!sessionId || !typed.trim()) return;
    const answer = typed.trim();
    setTyped('');
    setBusy('Thinking about the next question…');
    try {
      const r = await api.mock.answerText(sessionId, answer);
      handleResult(r, answer);
    } finally {
      setBusy(null);
    }
  };

  const toggleRecord = async () => {
    if (!sessionId) return;
    if (!rec.recording) {
      await rec.start();
      return;
    }
    const clip = await rec.stop();
    if (!clip) return;
    setBusy('Transcribing your answer & generating the next question…');
    try {
      const r = await api.mock.answerAudio(sessionId, clip.buffer, clip.mime);
      handleResult(r, r.transcript || '(no answer captured)');
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (!sessionId) return;
    setBusy('Generating your feedback report…');
    try {
      const r = (await api.mock.end(sessionId)) as SessionReport;
      setReport(r);
      setSessionId(null);
      setQuestion('');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page
      title="Mock Interview"
      subtitle="An AI interviewer asks questions out loud; you answer by voice or text, then get feedback."
    >
      {busy && <BusyOverlay message={busy} />}

      {!sessionId && !report && (
        <Card className="mb-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-neutral-400">Profile</span>
              <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">Select a profile…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.interviewType})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Interviewer voice</span>
              <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-neutral-400">Interview type</span>
            <Select
              value={interviewType}
              onChange={(e) => setInterviewType(e.target.value as InterviewType)}
            >
              {INTERVIEW_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </label>

          {profileId && (
            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-medium text-neutral-400">
                Job (optional — tailors questions to a JD)
              </span>
              <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">No specific job (use resume only)</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title || 'Untitled role'}
                    {j.company ? ` · ${j.company}` : ''}
                  </option>
                ))}
              </Select>
            </label>
          )}

          {!settings?.apiKeyPresent && (
            <p className="mt-3 text-xs text-amber-400">
              No OpenAI key —{' '}
              <Link to="/settings" className="underline">
                add it in Settings
              </Link>
            </p>
          )}
          <Button variant="primary" className="mt-4" onClick={start} disabled={!profileId}>
            <PlayIcon /> Start mock interview
          </Button>
        </Card>
      )}

      {sessionId && (
        <Card className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <Badge tone="blue">
              Question {progress.index} / {progress.total}
            </Badge>
            <Button variant="ghost" onClick={finish}>
              End & get feedback
            </Button>
          </div>

          <p className="mb-4 flex items-start gap-2 text-lg font-medium text-blue-200">
            <MicIcon className="mt-1 h-5 w-5 shrink-0 text-blue-300" />
            {question}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant={rec.recording ? 'danger' : 'success'} onClick={toggleRecord}>
              {rec.recording ? (
                <>
                  <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-white" /> Stop & submit
                  answer
                </>
              ) : (
                <>
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-white" /> Record answer
                </>
              )}
            </Button>
            <span className="text-xs text-neutral-500">or type your answer below</span>
          </div>
          {rec.error && <p className="mt-2 text-xs text-red-400">Mic error: {rec.error}</p>}

          <div className="mt-3 flex gap-2">
            <TextArea
              rows={2}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your answer…"
            />
            <Button variant="primary" onClick={submitTyped} disabled={!typed.trim()}>
              Submit
            </Button>
          </div>
        </Card>
      )}

      {turns.length > 0 && (
        <Card className="mb-5">
          <h3 className="mb-3 text-sm font-medium text-neutral-400">Conversation</h3>
          <div className="space-y-2 text-sm">
            {turns.map((t, i) => (
              <p key={i}>
                <span className={t.role === 'interviewer' ? 'text-blue-300' : 'text-neutral-500'}>
                  {t.role === 'interviewer' ? 'Interviewer' : 'You'}:{' '}
                </span>
                {t.text}
              </p>
            ))}
          </div>
        </Card>
      )}

      {report && (
        <Card>
          <h3 className="mb-3 font-medium">Feedback</h3>
          <p className="mb-3 text-sm text-neutral-200">{report.summary}</p>
          {report.strengths.length > 0 && (
            <ReportList title="Strengths" tone="text-green-300" items={report.strengths} />
          )}
          {report.improvements.length > 0 && (
            <ReportList title="Improvements" tone="text-amber-300" items={report.improvements} />
          )}
          <p className="mt-4 text-xs text-neutral-500">
            Full transcript is saved under Reports.
          </p>
        </Card>
      )}
    </Page>
  );
}

function ReportList({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  return (
    <div className="mt-2">
      <p className={`mb-1 font-medium ${tone}`}>{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-neutral-300">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
