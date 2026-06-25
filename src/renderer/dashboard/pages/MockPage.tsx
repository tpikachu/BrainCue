import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { InterviewType, Job } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Page, Select } from '../../components/ui';
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

export default function MockPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();

  const [profileId, setProfileId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [interviewType, setInterviewType] = useState<InterviewType>('behavioral');

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [asked, setAsked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null); // current clip's object URL (revoked on replace/unmount)
  const sessionIdRef = useRef<string | null>(null); // latest id, for the unmount cleanup

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

  // Keep a ref to the live mock id so the unmount cleanup ends it without a stale closure.
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Leaving the page mid-rehearsal must stop the audio, free the blob URL, and end
  // the mock session on the backend — otherwise it plays on / lingers as an orphan.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      if (sessionIdRef.current) void api.mock.end(sessionIdRef.current);
    },
    [],
  );

  useEffect(() => {
    setJobId('');
    if (!profileId) {
      setJobs([]);
      return;
    }
    void (async () => setJobs((await api.jobs.list(profileId)) as Job[]))();
  }, [profileId]);

  const play = (base64?: string) => {
    if (!base64) return;
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: 'audio/mpeg',
    });
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) audioRef.current = new Audio();
    // Replacing the source — free the previous clip's URL so they don't pile up.
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    audioRef.current.src = url;
    void audioRef.current.play().catch(() => {});
  };

  const start = async () => {
    if (!profileId) return;
    setError(null);
    if (!settings?.apiKeyPresent) {
      setError('Add your OpenAI API key in Settings first.');
      return;
    }
    setBusy('Starting rehearsal & generating the first question…');
    try {
      const r = await api.mock.start(profileId, voice, jobId || null, interviewType);
      setSessionId(r.session.id);
      setQuestion(r.question);
      setProgress({ index: r.index, total: r.total });
      setAsked([r.question]);
      play(r.audioBase64);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy('Thinking of the next question…');
    try {
      const r = await api.mock.next(sessionId);
      if (r.done || !r.question) {
        await finish();
        return;
      }
      setQuestion(r.question);
      setProgress({ index: r.index, total: r.total });
      setAsked((a) => [...a, r.question!]);
      play(r.audioBase64);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    const id = sessionId;
    setSessionId(null);
    setQuestion('');
    setAsked([]);
    if (id) await api.mock.end(id);
  };

  return (
    <Page
      title="Mock Interview"
      subtitle="An AI interviewer asks questions aloud and the copilot answers them in the Cue Card — a full rehearsal of the live experience. Mock runs aren’t saved."
    >
      {busy && <BusyOverlay message={busy} />}

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="shrink-0 rounded p-0.5 text-red-300/70 hover:text-red-200"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {!sessionId && (
        <Card className="mb-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-neutral-400">Profile</span>
              <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">Select a profile…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.targetRole ? ` · ${p.targetRole}` : ''}
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
                Interview (optional — tailors questions to a JD)
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
        <>
          <Card className="mb-5">
            <div className="mb-3 flex items-center justify-between">
              <Badge tone="blue">
                Question {progress.index} / {progress.total}
              </Badge>
              <Button variant="ghost" onClick={() => void finish()}>
                End rehearsal
              </Button>
            </div>

            <p className="mb-4 flex items-start gap-2 text-lg font-medium text-blue-200">
              <MicIcon className="mt-1 h-5 w-5 shrink-0 text-blue-300" />
              {question}
            </p>

            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void next()}>
                Next question
              </Button>
              <span className="text-xs text-neutral-500">
                The suggested answer streams into the <strong>Cue Card</strong> — read it or practice
                aloud, then move on.
              </span>
            </div>
          </Card>

          {asked.length > 1 && (
            <Card>
              <h3 className="mb-2 text-sm font-medium text-neutral-400">Questions asked</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-neutral-300">
                {asked.map((q, i) => (
                  <li key={i} className={i === asked.length - 1 ? 'text-neutral-100' : ''}>
                    {q}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
