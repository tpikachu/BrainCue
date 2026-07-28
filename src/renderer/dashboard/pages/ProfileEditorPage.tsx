import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import type { AppSettings, Profile, ProfileAbout } from '@shared/types';
import { EMPTY_PROFILE_ABOUT, PROFILE_ABOUT_FIELDS } from '@shared/types';
import { Badge, BusyOverlay, Button, Card, Field, Page, TextArea, TextInput } from '../../components/ui';
import { ChevronLeftIcon, UploadIcon } from '../../components/icons';
import { StoryBankModal } from '../StoryBankModal';
import { FLAGS } from '@shared/flags';

export default function ProfileEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [about, setAbout] = useState<ProfileAbout>(EMPTY_PROFILE_ABOUT);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [storyOpen, setStoryOpen] = useState(false);
  const [storyCount, setStoryCount] = useState(0);

  const loadStoryCount = useCallback(async () => {
    if (!id) return;
    setStoryCount((await api.stories.list(id)).length);
  }, [id]);

  const refresh = useCallback(async () => {
    if (!id) return;
    const p = (await api.profiles.get(id)) as Profile;
    setProfile(p);
    setName(p.name);
    setRole(p.targetRole);
    setResumeText(p.resumeText ?? '');
    setAbout({ ...EMPTY_PROFILE_ABOUT, ...(p.about ?? {}) });
    setKeyPresent(((await api.settings.get()) as AppSettings).apiKeyPresent);
    await loadStoryCount();
  }, [id, loadStoryCount]);

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
      await api.profiles.update(id, {
        name: name.trim() || 'Untitled',
        targetRole: role,
        about,
      });
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

  const aboutFilled = PROFILE_ABOUT_FIELDS.filter((f) => about[f.key].trim()).length;

  return (
    <Page
      title="Edit profile"
      subtitle="Who you are, what you're working on, and any documents worth grounding in."
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

      {/* About you — the questions whose answers actually change how well
          BrainCue can stand in for this person. A résumé says what they did for
          employers; this says who they are now. Each answered section is
          indexed as its own `profile` chunk, so it grounds answers in every
          mode rather than sitting in the database unread. */}
      <Card className="mb-5">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-medium">About you</h3>
          <Badge tone={aboutFilled > 0 ? 'green' : 'amber'}>
            {aboutFilled} of {PROFILE_ABOUT_FIELDS.length} answered
          </Badge>
        </div>
        <p className="mb-4 max-w-xl text-xs leading-relaxed text-neutral-500">
          The more of this you fill in, the better BrainCue can help in a live conversation. Answer
          what you can and skip the rest — nothing here is required, and you can come back to it.
          It stays in the local database.
        </p>
        <div className="space-y-3">
          {PROFILE_ABOUT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <TextArea
                rows={f.rows}
                value={about[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setAbout((a) => ({ ...a, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
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

      {/* Interview device — quarantined with the job-search surface. */}
      <Card className={`mb-5 ${FLAGS.jobSearch ? '' : 'hidden'}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Story Bank</h3>
              {storyCount > 0 && (
                <Badge tone="blue">
                  {storyCount} {storyCount === 1 ? 'story' : 'stories'}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              Reusable STAR stories from your résumé — rehearse them, and they ground your live
              answers.
            </p>
          </div>
          <Button
            variant="default"
            className="shrink-0"
            disabled={!profile.parsedResume}
            title={profile.parsedResume ? 'Manage your STAR stories' : 'Parse a résumé first'}
            onClick={() => setStoryOpen(true)}
          >
            Manage stories
          </Button>
        </div>
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

      <StoryBankModal
        open={storyOpen}
        profile={profile}
        keyPresent={keyPresent}
        onClose={() => setStoryOpen(false)}
        onChanged={() => void loadStoryCount()}
      />
    </Page>
  );
}
