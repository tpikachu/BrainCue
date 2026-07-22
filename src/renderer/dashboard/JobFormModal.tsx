import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { FLAGS } from '@shared/flags';
import type { CompanionSpaceOverrides, Job } from '@shared/types';
import { Button, Field, Modal, Select, TextArea, TextInput } from '../components/ui';
import { UploadIcon } from '../components/icons';

type Notice = { tone: 'ok' | 'err'; text: string } | null;

/** Create a new interview (job/client) or edit an existing one. Reused from the
 *  jobs table ("New interview" and per-row "Detail"). */
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
      setNotice({ tone: 'err', text: 'Add at least a title or a job description.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.jobs.save({
        id: job?.id,
        profileId,
        title: form.title.trim() || 'Untitled role',
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
        setNotice({ tone: 'err', text: `Saved, but company research failed: ${res.companyError}` });
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
    <Modal open={open} onClose={onClose} title={editing ? 'Edit interview' : 'New interview'}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Interview name / role">
            <TextInput
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Acme — Senior PM"
            />
          </Field>
          <Field label="Client / company">
            <TextInput
              value={form.company}
              onChange={(e) => set({ company: e.target.value })}
              placeholder="e.g. Acme"
            />
          </Field>
        </div>

        <Field label="JD link (optional)" hint="We'll try to pull the description in. Some sites block this; paste below if so.">
          <div className="flex gap-2">
            <TextInput
              type="url"
              value={form.jdUrl}
              onChange={(e) => set({ jdUrl: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && fetchJd()}
              placeholder="https://company.com/careers/123"
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
          <UploadIcon /> Upload JD file
        </Button>

        <Field label="Job description (parsed for grounding)">
          <TextArea
            rows={5}
            value={form.jdText}
            onChange={(e) => set({ jdText: e.target.value })}
            placeholder="Paste the job description"
          />
        </Field>

        <Field
          label="Company website (optional)"
          hint="On save we research the site so answers can speak to the company. Needs an OpenAI key."
        >
          <TextInput
            type="url"
            value={form.companyUrl}
            onChange={(e) => set({ companyUrl: e.target.value })}
            placeholder="https://company.com"
          />
        </Field>

        <Field
          label="Notes about this client (optional)"
          hint="On hand while you pick this client and inside the Cue Card during the session."
        >
          <TextArea
            rows={3}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="e.g. Recruiter: Jane. Panel of 3. They care about system design. Remote."
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
