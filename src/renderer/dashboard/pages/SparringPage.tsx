import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAnswerRecorder } from '../../lib/useAnswerRecorder';
import type { InterviewType, Job, SparringFeedback } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Page, Select, Spinner } from '../../components/ui';
import { MicIcon, PlayIcon } from '../../components/icons';

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const INTERVIEW_TYPES: InterviewType[] = [
  'behavioral',
  'technical',
  'coding',
  'system_design',
  'general',
];

type Phase = 'setup' | 'question' | 'recording' | 'evaluating' | 'feedback' | 'done';

/** Encode an ArrayBuffer to base64 in chunks (avoids the call-stack blowup of
 *  spreading a large Uint8Array into String.fromCharCode). */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export default function SparringPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const recorder = useAnswerRecorder();

  const [profileId, setProfileId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [interviewType, setInterviewType] = useState<InterviewType>('behavioral');

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [question, setQuestion] = useState('');
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [transcript, setTranscript] = useState('');
  const [feedback, setFeedback] = useState<SparringFeedback | null>(null);
  const [completed, setCompleted] = useState<{ question: string; rating: number }[]>([]);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const lastAudioRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Synchronous "recording in progress" gate — set before the async getUserMedia so
  // endRecord can't be fooled by a stale render-closure `phase` on a fast tap.
  const recordingRef = useRef(false);
  const endRecordRef = useRef<() => void>(() => {});

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Leaving mid-session: stop audio, free the blob URL, stop any recording, and end
  // the (in-memory) sparring session on the backend.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      void recorder.stop();
      if (sessionIdRef.current) void api.sparring.end(sessionIdRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Surface mic errors (e.g. permission denied) and drop back out of recording.
  useEffect(() => {
    if (recorder.error) {
      recordingRef.current = false;
      setError(recorder.error);
      setPhase((p) => (p === 'recording' ? 'question' : p));
    }
  }, [recorder.error]);

  // Backstop for keyboard (Space) PTT: if focus/visibility is lost mid-hold the
  // button's keyup never fires, so release the recording on window blur / tab hide.
  useEffect(() => {
    const release = () => {
      if (recordingRef.current) endRecordRef.current();
    };
    const onVis = () => document.hidden && release();
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    setJobId('');
    if (!profileId) {
      setJobs([]);
      return;
    }
    void (async () => setJobs((await api.jobs.list(profileId)) as Job[]))();
  }, [profileId]);

  const play = (base64?: string) => {
    if (!base64) {
      setAudioPlaying(false);
      return;
    }
    lastAudioRef.current = base64;
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: 'audio/mpeg',
    });
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) audioRef.current = new Audio();
    // Clear the gate on any completion path so the answer button can't get stuck
    // disabled if playback ends, errors mid-stream, or stalls.
    audioRef.current.onended = () => setAudioPlaying(false);
    audioRef.current.onerror = () => setAudioPlaying(false);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    audioRef.current.src = url;
    setAudioPlaying(true);
    void audioRef.current.play().catch(() => setAudioPlaying(false));
  };

  const start = async () => {
    if (!profileId) return;
    setError(null);
    if (!settings?.apiKeyPresent) {
      setError('Add your OpenAI API key in Settings first.');
      return;
    }
    setBusy('Starting & generating the first question…');
    try {
      const r = await api.sparring.start(profileId, voice, jobId || null, interviewType);
      setSessionId(r.sessionId);
      setQuestion(r.question);
      setProgress({ index: r.index, total: r.total });
      setTranscript('');
      setFeedback(null);
      setCompleted([]);
      setPhase('question');
      play(r.audioBase64);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const beginRecord = async () => {
    if (phase !== 'question' || audioPlaying || recordingRef.current) return;
    recordingRef.current = true; // synchronous — gates endRecord regardless of render timing
    setError(null);
    setPhase('recording');
    await recorder.start();
  };

  const endRecord = async () => {
    if (!recordingRef.current) return; // not recording (or already ended) — ignore
    recordingRef.current = false;
    // Always call stop(): if start() is still acquiring the mic, this cancels it so
    // the stream is released rather than leaked.
    const clip = await recorder.stop();
    if (!clip || clip.buffer.byteLength === 0) {
      setPhase('question'); // too short / nothing captured — let them try again
      return;
    }
    if (!sessionId) return;
    setPhase('evaluating');
    try {
      const r = await api.sparring.answer(sessionId, toBase64(clip.buffer), clip.mime);
      setTranscript(r.transcript);
      setFeedback(r.feedback);
      setCompleted((c) => [...c, { question, rating: r.feedback.rating }]);
      setPhase('feedback');
    } catch (e) {
      setError((e as Error).message);
      setPhase('question');
    }
  };
  endRecordRef.current = () => void endRecord();

  const next = async () => {
    if (!sessionId) return;
    setError(null);
    setBusy('Thinking of the next question…');
    try {
      const r = await api.sparring.next(sessionId);
      if (r.done || !r.question) {
        setPhase('done');
        return;
      }
      setQuestion(r.question);
      setProgress({ index: r.index, total: r.total });
      setTranscript('');
      setFeedback(null);
      setPhase('question');
      play(r.audioBase64);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    const id = sessionId;
    audioRef.current?.pause();
    recordingRef.current = false;
    void recorder.stop(); // release the mic if a recording is somehow still live
    setSessionId(null);
    setPhase('setup');
    setQuestion('');
    setTranscript('');
    setFeedback(null);
    setProgress({ index: 0, total: 0 });
    if (id) await api.sparring.end(id);
  };

  const avgRating =
    completed.length > 0
      ? Math.round((completed.reduce((s, c) => s + c.rating, 0) / completed.length) * 10) / 10
      : 0;

  return (
    <Page
      title="Sparring"
      subtitle="A two-way voice mock: the AI asks aloud, you answer by speaking, and it coaches each answer. Hold the button to talk. Every drill is saved to Reports, so your scores build a trend."
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

      {phase === 'setup' && (
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
            <Select value={interviewType} onChange={(e) => setInterviewType(e.target.value as InterviewType)}>
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
          <Button variant="primary" className="mt-4" onClick={() => void start()} disabled={!profileId}>
            <PlayIcon /> Start sparring
          </Button>
        </Card>
      )}

      {sessionId && phase !== 'done' && (
        <>
          <Card className="mb-5">
            <div className="mb-3 flex items-center justify-between">
              <Badge tone="blue">
                Question {progress.index} / {progress.total}
              </Badge>
              <Button variant="ghost" onClick={() => void finish()}>
                End sparring
              </Button>
            </div>

            <p className="mb-4 flex items-start gap-2 text-lg font-medium text-blue-200">
              <MicIcon className="mt-1 h-5 w-5 shrink-0 text-blue-300" />
              {question}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={audioPlaying || phase === 'evaluating'}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  void beginRecord();
                }}
                onPointerUp={() => void endRecord()}
                onPointerCancel={() => void endRecord()}
                onKeyDown={(e) => {
                  if (e.code === 'Space' && !e.repeat) {
                    e.preventDefault();
                    void beginRecord();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.code === 'Space') {
                    e.preventDefault();
                    void endRecord();
                  }
                }}
                className={`select-none rounded-xl px-5 py-3 text-sm font-semibold transition-colors ${
                  phase === 'recording'
                    ? 'bg-red-600 text-white shadow-lg shadow-red-900/40'
                    : audioPlaying || phase === 'evaluating'
                      ? 'cursor-not-allowed bg-neutral-800 text-neutral-500'
                      : 'bg-indigo-600 text-white hover:bg-indigo-500'
                }`}
              >
                {phase === 'recording'
                  ? '● Recording — release to submit'
                  : phase === 'evaluating'
                    ? 'Evaluating…'
                    : audioPlaying
                      ? '🔊 Listen to the question…'
                      : '🎤 Hold to answer'}
              </button>

              {phase === 'evaluating' && <Spinner className="h-4 w-4" />}

              {lastAudioRef.current && phase !== 'recording' && phase !== 'evaluating' && (
                <Button variant="ghost" onClick={() => play(lastAudioRef.current ?? undefined)}>
                  🔁 Replay
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Hold the button (or focus it and hold <kbd>Space</kbd>) while you speak; release to
              submit. The mic only records while you hold it.
            </p>
          </Card>

          {(transcript || feedback) && phase === 'feedback' && (
            <Card className="mb-5">
              {transcript && (
                <p className="mb-3 text-sm text-neutral-300">
                  <span className="font-semibold text-neutral-400">You said: </span>
                  <span className="italic">“{transcript}”</span>
                </p>
              )}
              {feedback && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge tone={feedback.rating >= 4 ? 'green' : feedback.rating <= 2 ? 'red' : 'amber'}>
                      {feedback.rating}/5
                    </Badge>
                    <span className="text-sm text-neutral-200">{feedback.verdict}</span>
                  </div>
                  {feedback.strengths.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-green-400">
                        Strengths
                      </h4>
                      <ul className="list-disc space-y-0.5 pl-5 text-sm text-neutral-300">
                        {feedback.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {feedback.improvements.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
                        Work on
                      </h4>
                      <ul className="list-disc space-y-0.5 pl-5 text-sm text-neutral-300">
                        {feedback.improvements.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {feedback.tip && (
                    <p className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200">
                      💡 {feedback.tip}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4">
                <Button variant="primary" onClick={() => void next()}>
                  {progress.index >= progress.total ? 'Finish' : 'Next question'}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      {phase === 'done' && (
        <Card>
          <h3 className="text-lg font-medium text-neutral-100">Sparring complete</h3>
          <p className="mt-1 text-sm text-neutral-400">
            {completed.length} answer{completed.length === 1 ? '' : 's'} coached
            {completed.length > 0 ? ` · average ${avgRating}/5` : ''}.
          </p>
          {completed.length > 0 && (
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-neutral-300">
              {completed.map((c, i) => (
                <li key={i}>
                  <span className="text-neutral-400">[{c.rating}/5]</span> {c.question}
                </li>
              ))}
            </ol>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" onClick={() => void finish()}>
              Start another
            </Button>
            <Link to="/reports" className="text-sm text-indigo-300 underline-offset-2 hover:underline">
              See your practice trend in Reports →
            </Link>
          </div>
        </Card>
      )}
    </Page>
  );
}
