import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { FLAGS } from '@shared/flags';
import { ACTIVITIES, ACTIVITY_ORDER, DEFAULT_ACTIVITY, activity, isInterviewSpace } from '@shared/activities';
import type { CompanionSpaceOverrides, ContextPackKind, Job } from '@shared/types';
import { Button, Field, Modal, Select, TextArea, TextInput } from '../components/ui';
import { UploadIcon } from '../components/icons';

type Notice = { tone: 'ok' | 'err'; text: string } | null;

/** Create or edit a Space — the bundle of context a conversation is grounded in.
 *
 *  Every field here used to be named for a job interview, so setting one up for
 *  a standup meant filling in a "job description". The shape was always general;
 *  only the words were not. The activity picked at the top supplies the
 *  vocabulary (shared/activities.ts) over exactly the same storage — and it is
 *  the same list the start flow uses, because a Space IS a saved activity. */
export function JobFormModal({
  open,
  profileId,
  job,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  profileId: string;
  job?: Job | null; // present => edit mode
  onClose: () => void;
  onSaved: (job: Job) => void;
  onDeleted?: (id: string) => void;
}) {
  const editing = !!job;
  const empty = { title: '', company: '', jdUrl: '', jdText: '', companyUrl: '', notes: '' };
  const [form, setForm] = useState(empty);
  // New Spaces default to the daily case. Editing keeps whatever the Space
  // already is, so v1 job rows stay jobs.
  const [kind, setKind] = useState<ContextPackKind>(DEFAULT_ACTIVITY);
  const copy = activity(kind);
  const [companion, setCompanion] = useState<CompanionSpaceOverrides>({});
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [jdNotice, setJdNotice] = useState<Notice>(null);
  const [notice, setNotice] = useState<Notice>(null);

  // Reset the form to the (edited) job each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setForm({
      title: job?.title ?? '',
      company: job?.company ?? '',
      jdUrl: job?.jdUrl ?? '',
      jdText: job?.jdText ?? '',
      companyUrl: job?.companyUrl ?? '',
      notes: job?.notes ?? '',
    });
    setKind((job?.kind as ContextPackKind) ?? DEFAULT_ACTIVITY);
    setCompanion(job?.companionPrefs ?? {});
    setJdNotice(null);
    setNotice(null);
  }, [open, job?.id]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const uploadJd = async () => {
    const { filePath } = await api.dialog.openFile();
    if (!filePath) return;
    const { text } = await api.documents.extractFile(filePath);
    set({ jdText: text });
  };

  const fetchJd = async () => {
    const url = form.jdUrl.trim();
    if (!url) return;
    setFetching(true);
    setJdNotice(null);
    try {
      const { text, title } = await api.documents.fetchUrl(url);
      set({ jdText: text, title: form.title || title || '' });
      setJdNotice({ tone: 'ok', text: 'Fetched the page text — review & trim it below.' });
    } catch (e) {
      setJdNotice({
        tone: 'err',
        text: `${(e as Error).message} Paste the description below so it can be parsed precisely.`,
      });
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (!form.title.trim() && !form.jdText.trim()) {
      setNotice({ tone: 'err', text: `Add at least a name or ${copy.docLabel.toLowerCase()}.` });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.jobs.save({
        id: job?.id,
        profileId,
        kind,
        title: form.title.trim() || copy.titleLabel,
        company: form.company.trim() || null,
        jdUrl: form.jdUrl.trim() || null,
        jdText: form.jdText.trim() || null,
        companyUrl: form.companyUrl.trim() || null,
        notes: form.notes.trim() || null,
      });
      // Companion overrides ride separately (setCompanionPrefs — no re-parse).
      // All-inherit → null so the row reads "no overrides", not "{}".
      if (FLAGS.companion) {
        const hasOverrides = Object.values(companion).some((v) => v !== undefined);
        const saved = await api.jobs.setCompanionPrefs(
          (res.job as Job).id,
          hasOverrides ? companion : null,
        );
        onSaved(saved as Job);
      } else {
        onSaved(res.job as Job);
      }
      if (res.companyError) {
        setNotice({ tone: 'err', text: `Saved, but reading the link failed: ${res.companyError}` });
      } else {
        onClose();
      }
    } catch (e) {
      setNotice({ tone: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!job) return;
    await api.jobs.delete(job.id);
    onDeleted?.(job.id);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit Space' : 'New Space'}>
      <div className="space-y-3">
        <Field label="What is this Space for?" hint={copy.hint}>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as ContextPackKind)}
            disabled={editing}
          >
            {ACTIVITY_ORDER.map((k) => (
              <option key={k} value={k}>
                {ACTIVITIES[k].label}
              </option>
            ))}
          </Select>
        </Field>
        {editing && (
          <p className="text-xs text-neutral-500">
            A Space&rsquo;s kind is fixed after it is created — its documents are already indexed
            under it. Create a new Space if this one is really something else.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={copy.titleLabel}>
            <TextInput
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder={copy.titlePlaceholder}
            />
          </Field>
          <Field label={copy.partyLabel}>
            <TextInput
              value={form.company}
              onChange={(e) => set({ company: e.target.value })}
              placeholder={copy.partyPlaceholder}
            />
          </Field>
        </div>

        <Field
          label={`${copy.docLabel} — link (optional)`}
          hint="We'll try to pull the page text in. Some sites block this; paste below if so."
        >
          <div className="flex gap-2">
            <TextInput
              type="url"
              value={form.jdUrl}
              onChange={(e) => set({ jdUrl: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && fetchJd()}
              placeholder={copy.linkPlaceholder}
              className="flex-1"
            />
            <Button variant="default" onClick={fetchJd} loading={fetching} disabled={!form.jdUrl.trim()}>
              Fetch
            </Button>
          </div>
        </Field>
        {jdNotice && (
          <p className={`text-xs ${jdNotice.tone === 'err' ? 'text-amber-400' : 'text-green-400'}`}>
            {jdNotice.text}
          </p>
        )}

        <Button variant="default" onClick={uploadJd}>
          <UploadIcon /> Upload a file
        </Button>

        <Field
          label={`${copy.docLabel}${copy.docOptional ? ' (optional)' : ''}`}
          hint={
            isInterviewSpace(kind)
              ? 'Parsed into requirements and responsibilities, then indexed for grounding.'
              : 'Indexed for grounding — answers here can cite it.'
          }
        >
          <TextArea
            rows={5}
            value={form.jdText}
            onChange={(e) => set({ jdText: e.target.value })}
            placeholder={copy.docPlaceholder}
          />
        </Field>

        <Field
          label={`${copy.linkLabel} (optional)`}
          hint="On save we read the page so answers can speak to it. Needs an OpenAI key."
        >
          <TextInput
            type="url"
            value={form.companyUrl}
            onChange={(e) => set({ companyUrl: e.target.value })}
            placeholder={copy.linkPlaceholder}
          />
        </Field>

        <Field
          label={`${copy.notesLabel} (optional)`}
          hint="On hand while you pick this Space and inside the Cue Card during the session."
        >
          <TextArea
            rows={3}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder={copy.notesPlaceholder}
          />
        </Field>

        {FLAGS.companion && (
          <fieldset className="rounded-xl border border-white/5 bg-neutral-950/40 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Companion in this Space
            </legend>
            <p className="mb-2 text-xs text-neutral-500">
              Overrides for companion sessions grounded here — anything left on “Inherit” uses your
              global companion settings.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Presence">
                <Select
                  value={companion.presence ?? ''}
                  onChange={(e) =>
                    setCompanion((c) => ({
                      ...c,
                      presence: (e.target.value || undefined) as CompanionSpaceOverrides['presence'],
                    }))
                  }
                >
                  <option value="">Inherit</option>
                  <option value="off">Off (muted)</option>
                  <option value="on_demand">On demand</option>
                  <option value="assistive">Assistive</option>
                  <option value="proactive">Proactive</option>
                </Select>
              </Field>
              <Field label="Tone">
                <Select
                  value={companion.tone ?? ''}
                  onChange={(e) =>
                    setCompanion((c) => ({
                      ...c,
                      tone: (e.target.value || undefined) as CompanionSpaceOverrides['tone'],
                    }))
                  }
                >
                  <option value="">Inherit</option>
                  <option value="warm">Warm</option>
                  <option value="neutral">Neutral</option>
                  <option value="direct">Direct</option>
                </Select>
              </Field>
              <Field label="Brevity">
                <Select
                  value={companion.brevity ?? ''}
                  onChange={(e) =>
                    setCompanion((c) => ({
                      ...c,
                      brevity: (e.target.value || undefined) as CompanionSpaceOverrides['brevity'],
                    }))
                  }
                >
                  <option value="">Inherit</option>
                  <option value="terse">Terse</option>
                  <option value="normal">Normal</option>
                  <option value="chatty">Chatty</option>
                </Select>
              </Field>
              <Field label="Humor">
                <Select
                  value={companion.humor === undefined ? '' : companion.humor ? '1' : '0'}
                  onChange={(e) =>
                    setCompanion((c) => ({
                      ...c,
                      humor: e.target.value === '' ? undefined : e.target.value === '1',
                    }))
                  }
                >
                  <option value="">Inherit</option>
                  <option value="1">Allowed</option>
                  <option value="0">Off</option>
                </Select>
              </Field>
            </div>
          </fieldset>
        )}

        {notice && (
          <p className={`text-sm ${notice.tone === 'err' ? 'text-amber-400' : 'text-green-400'}`}>
            {notice.text}
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          {editing ? (
            <Button variant="ghost" className="text-red-300" onClick={del}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              {form.companyUrl.trim() ? 'Save & research' : editing ? 'Save changes' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
