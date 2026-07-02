import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useLiveSession } from '../../store/useLiveSession';
import type { Application, ApplicationListItem } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Field, Page, Select, TextArea, TextInput } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ApplicationModal } from '../ApplicationModal';
import { PlayIcon, UploadIcon } from '../../components/icons';

const APPS_PER_PAGE = 8;

export default function TailorPage() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const live = useLiveSession();
  const { session } = live;

  // ---- Tailor form ----
  const [profileId, setProfileId] = useState(''); // '' = upload/paste a base resume instead
  const [baseText, setBaseText] = useState('');
  const [baseFile, setBaseFile] = useState<string | null>(null);
  const [jdText, setJdText] = useState('');
  const [jdUrl, setJdUrl] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- Result / detail modal ----
  const [viewApp, setViewApp] = useState<Application | null>(null);
  const [viewOpen, setViewOpen] = useState(false);

  // ---- Applications table (server-paginated + searchable, newest first) ----
  const [rows, setRows] = useState<ApplicationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rev, setRev] = useState(0); // bump to re-fetch after tailor/delete
  const [busyAppId, setBusyAppId] = useState<string | null>(null);

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

  // (Re)load the current page on search/page change (search debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      api.applications
        .page(query.trim(), APPS_PER_PAGE, page * APPS_PER_PAGE)
        .then((r) => {
          setRows(r.items);
          setTotal(r.total);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query, page, rev]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const baseReady = profileId ? !!selectedProfile?.resumeText : !!baseText.trim();
  const canTailor = baseReady && !!jdText.trim() && !!settings?.apiKeyPresent;

  const withBusy = async (msg: string, fn: () => Promise<void>) => {
    setBusyMsg(msg);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyMsg(null);
    }
  };

  const uploadBase = () =>
    withBusy('Extracting text from file…', async () => {
      const { filePath } = await api.dialog.openFile();
      if (!filePath) return;
      const { text, filename } = (await api.documents.extractFile(filePath)) as {
        text: string;
        filename: string;
      };
      setProfileId('');
      setBaseText(text);
      setBaseFile(filename);
    });

  const uploadJd = () =>
    withBusy('Extracting text from file…', async () => {
      const { filePath } = await api.dialog.openFile();
      if (!filePath) return;
      const { text } = (await api.documents.extractFile(filePath)) as { text: string };
      setJdText(text);
    });

  const fetchJd = () =>
    withBusy('Fetching the job posting…', async () => {
      if (!jdUrl.trim()) return;
      const { text } = (await api.documents.fetchUrl(jdUrl.trim())) as { text: string };
      setJdText(text);
    });

  const tailor = () =>
    withBusy('Tailoring your resume — this can take a minute…', async () => {
      const questions = questionsText
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean);
      const r = await api.applications.tailor({
        profileId: profileId || null,
        baseResumeText: profileId ? null : baseText,
        jdText: jdText.trim(),
        questions,
      });
      setViewApp(r.application);
      setViewOpen(true);
      setPage(0);
      setRev((v) => v + 1);
      void load(); // an uploaded base resume may have created a new profile
      // Saved, but grounding wasn't embedded (e.g. a rate limit) — recoverable.
      if (r.indexError)
        setError(
          `Application saved, but indexing its grounding failed (${r.indexError}). ` +
            'Open it and press "Re-index" so interviews use the tailored resume.',
        );
    });

  // Start a live interview grounded in this application's tailored resume + JD.
  const startInterview = async (app: ApplicationListItem) => {
    if (session) return;
    setBusyAppId(app.id);
    try {
      const a = settings?.audio ?? { source: 'system' as const, micDeviceId: null };
      await live.startNew({
        profileId: app.profileId,
        jobId: app.jobId,
        interviewType: 'general',
        answerFormat: 'key_points',
        source: a.source,
        micDeviceId: a.micDeviceId,
      });
    } finally {
      setBusyAppId(null);
    }
  };

  const openApp = async (id: string) => {
    try {
      setViewApp(await api.applications.get(id));
      setViewOpen(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const columns: Column<ApplicationListItem>[] = [
    {
      key: 'label',
      header: 'Application',
      render: (a) => (
        <div>
          <div className="font-medium text-neutral-100">
            {a.name} - {a.jobTitle || 'Untitled role'}
            {a.company ? ` at ${a.company}` : ''}
          </div>
          {a.profileName && <div className="text-xs text-neutral-500">{a.profileName}</div>}
        </div>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'w-40',
      render: (a) => (
        <span className="text-xs text-neutral-400">{new Date(a.createdAt).toLocaleString()}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-56 text-right',
      render: (a) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {session?.jobId === a.jobId ? (
            <Badge tone="green">● live</Badge>
          ) : (
            <Button
              variant="success"
              disabled={!settings?.apiKeyPresent || !!session}
              loading={busyAppId === a.id}
              title="Start a live interview grounded in this tailored resume + JD"
              onClick={() => void startInterview(a)}
            >
              <PlayIcon /> Start interview
            </Button>
          )}
          <Button variant="ghost" onClick={() => void openApp(a.id)}>
            View
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Page
      title="Tailor Resume"
      subtitle="Turn your resume + a job description into an ATS-friendly tailored resume and application answers — then interview against exactly what you submitted."
    >
      {busyMsg && <BusyOverlay message={busyMsg} />}

      {(error || live.micError || live.sessionError) && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error || live.micError || live.sessionError}</span>
          <button
            onClick={() => {
              setError(null);
              live.clearMicError();
              live.clearSessionError();
            }}
            className="shrink-0 rounded p-0.5 text-red-300/70 hover:text-red-200"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {session && (
        <p className="mb-4 text-xs text-neutral-500">
          ● An interview is live — transcript, answers, and all controls are in the Cue Card.
        </p>
      )}

      <div className="space-y-5">
        {/* The tailor form. */}
        <Card>
          <h3 className="mb-1 font-medium">New application</h3>
          <p className="mb-4 text-xs text-neutral-500">
            The tailored resume is grounded ONLY in your base resume — reworded and reordered for
            the job, never invented.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Base resume — use a profile…">
              <Select
                value={profileId}
                onChange={(e) => {
                  setProfileId(e.target.value);
                  if (e.target.value) {
                    setBaseText('');
                    setBaseFile(null);
                  }
                }}
              >
                <option value="">Upload / paste instead…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.targetRole ? ` · ${p.targetRole}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {!profileId && (
              <Field label="…or upload a resume file">
                <Button variant="default" onClick={() => void uploadBase()}>
                  <UploadIcon /> Upload (PDF / DOCX / TXT / MD)
                </Button>
                {baseFile && (
                  <span className="ml-2 align-middle text-xs text-green-300">{baseFile} ✓</span>
                )}
              </Field>
            )}
          </div>

          {profileId && selectedProfile && !selectedProfile.resumeText && (
            <p className="mt-2 text-xs text-amber-400">
              ⚠ This profile has no resume text —{' '}
              <Link to={`/profiles/${selectedProfile.id}`} className="underline">
                add one
              </Link>{' '}
              or upload a file instead.
            </p>
          )}

          {!profileId && (
            <div className="mt-3">
              <Field label="Base resume text">
                <TextArea
                  rows={6}
                  value={baseText}
                  onChange={(e) => setBaseText(e.target.value)}
                  placeholder="Paste your resume text (or upload a file above). A reusable profile is created from it."
                />
              </Field>
            </div>
          )}

          <div className="mt-4">
            <Field label="Job description">
              <TextArea
                rows={6}
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                placeholder="Paste the job description…"
              />
            </Field>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="default" onClick={() => void uploadJd()}>
                <UploadIcon /> Upload JD
              </Button>
              <TextInput
                value={jdUrl}
                onChange={(e) => setJdUrl(e.target.value)}
                placeholder="…or paste the posting URL"
                className="min-w-56 flex-1"
              />
              <Button variant="default" disabled={!jdUrl.trim()} onClick={() => void fetchJd()}>
                Fetch
              </Button>
            </div>
          </div>

          <div className="mt-4">
            <Field label="Application questions (optional — one per line)">
              <TextArea
                rows={3}
                value={questionsText}
                onChange={(e) => setQuestionsText(e.target.value)}
                placeholder={'Why do you want to work here?\nDescribe a challenging project you led.'}
              />
            </Field>
          </div>

          {!settings?.apiKeyPresent && (
            <p className="mt-3 text-xs text-amber-400">
              ⚠ No OpenAI key —{' '}
              <Link to="/settings" className="underline">
                add it in Settings
              </Link>
              .
            </p>
          )}

          <Button
            variant="primary"
            className="mt-4"
            disabled={!canTailor}
            onClick={() => void tailor()}
          >
            Tailor resume
          </Button>
        </Card>

        {/* Applications — dense, paginated, searchable, newest first. */}
        <Card>
          <div className="mb-3">
            <h3 className="font-medium">Applications</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Every tailored application, newest first. <strong>Start interview</strong> grounds a
              live session in that application’s tailored resume + JD.
            </p>
          </div>
          <DataTable<ApplicationListItem>
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            total={total}
            page={page}
            pageSize={APPS_PER_PAGE}
            onPage={setPage}
            query={query}
            onQuery={(q) => {
              setQuery(q);
              setPage(0);
            }}
            searchPlaceholder="Search by name, role, or company…"
            onRowClick={(a) => void openApp(a.id)}
            loading={loading}
            empty="No applications yet — tailor your first resume above."
          />
        </Card>
      </div>

      <ApplicationModal
        open={viewOpen}
        app={viewApp}
        onClose={() => setViewOpen(false)}
        onDeleted={() => {
          setPage(0);
          setRev((v) => v + 1);
        }}
      />
    </Page>
  );
}
