import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import type { AppSettings, Profile } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Field, Page, TextArea, TextInput } from '../../components/ui';
import { ChevronLeftIcon, UploadIcon } from '../../components/icons';

export default function ProfileEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    const p = (await api.profiles.get(id)) as Profile;
    setProfile(p);
    setName(p.name);
    setRole(p.targetRole);
    setResumeText(p.resumeText ?? '');
    setKeyPresent(((await api.settings.get()) as AppSettings).apiKeyPresent);
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = async (msg: string, fn: () => Promise<void>) => {
    setBusyMsg(msg);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setStatus({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusyMsg(null);
    }
  };

  const pickFile = () =>
    withBusy('Extracting text from file…', async () => {
      const { filePath } = await api.dialog.openFile();
      if (!filePath) return;
      const { text } = await api.documents.extractFile(filePath);
      setResumeText(text);
      setStatus({ tone: 'ok', text: 'File loaded — review it, then Save.' });
    });

  const save = () =>
    withBusy(keyPresent ? 'Saving & parsing…' : 'Saving…', async () => {
      if (!id) return;
      await api.profiles.update(id, { name: name.trim() || 'Untitled', targetRole: role });
      const res = await api.documents.saveResume(id, resumeText);
      await refresh();
      setStatus({
        tone: 'ok',
        text: res.keyMissing
          ? 'Saved ✓ — add an OpenAI key in Settings to parse the resume.'
          : `Saved & parsed ✓ — ${res.embedded} chunks indexed.`,
      });
    });

  if (!profile) return <BusyOverlay message="Loading profile…" />;

  return (
    <Page
      title="Edit profile"
      subtitle="Your name, role, and resume. Jobs and interview settings live in Live Session."
      width="max-w-2xl"
      actions={
        <Link to="/profiles">
          <Button variant="ghost">
            <ChevronLeftIcon /> Profiles
          </Button>
        </Link>
      }
    >
      {busyMsg && <BusyOverlay message={busyMsg} />}

      {!keyPresent && (
        <div className="mb-5 rounded-xl border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
          You can save now, but parsing & grounded answers need an OpenAI key.{' '}
          <Link to="/settings" className="font-medium underline">
            Add it in Settings
          </Link>
          .
        </div>
      )}

      <Card className="mb-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Your role / title">
            <TextInput value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Senior PM" />
          </Field>
        </div>
      </Card>

      <Card className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium">Resume</h3>
          {profile.parsedResume ? <Badge tone="green">parsed ✓</Badge> : <Badge tone="amber">not parsed</Badge>}
        </div>
        <Button variant="default" className="mb-3" onClick={pickFile}>
          <UploadIcon /> Upload file (PDF / DOCX / TXT / MD)
        </Button>
        <Field label="…or paste resume text">
          <TextArea
            rows={14}
            value={resumeText}
            onChange={(e) => setResumeText(e.target.value)}
            placeholder="Paste your resume"
          />
        </Field>
      </Card>

      <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/90 px-4 py-3 backdrop-blur">
        <span className="text-sm">
          {status ? (
            <span className={status.tone === 'err' ? 'text-red-300' : 'text-green-300'}>{status.text}</span>
          ) : (
            <span className="text-neutral-500">Resume is stored locally; only its text is sent to OpenAI.</span>
          )}
        </span>
        <Button variant="primary" onClick={save}>
          {keyPresent ? 'Save & parse' : 'Save'}
        </Button>
      </div>
    </Page>
  );
}
