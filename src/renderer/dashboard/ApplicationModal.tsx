import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Application } from '@shared/types';
import { Badge, Button, Modal } from '../components/ui';
import { Markdown } from '../components/Markdown';

/** View one application: the tailored resume (markdown), the grounded answers to
 *  the application questions, PDF download, and delete. Used both for a fresh
 *  tailoring result and for rows opened from the applications table. */
export function ApplicationModal({
  open,
  app,
  onClose,
  onDeleted,
}: {
  open: boolean;
  app: Application | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset transient state whenever a different application (or none) is shown.
  useEffect(() => {
    setBusy(null);
    setNotice(null);
    setError(null);
    setConfirmDelete(false);
  }, [open, app?.id]);

  if (!app) return null;
  const label = `${app.name} - ${app.jobTitle}${app.company ? ` at ${app.company}` : ''}`;

  const downloadPdf = async () => {
    setBusy('Exporting PDF…');
    setError(null);
    setNotice(null);
    try {
      const r = await api.applications.exportPdf(app.id);
      if (r.saved) setNotice(`Saved to ${r.filePath}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    setBusy('Deleting…');
    setError(null);
    try {
      await api.applications.delete(app.id);
      onDeleted(app.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Recovery path when indexing failed at tailor time (also re-embeds after
  // switching the embedding model): re-index the JD + tailored grounding chunks.
  const reindex = async () => {
    setBusy('Re-indexing…');
    setError(null);
    setNotice(null);
    try {
      const r = await api.applications.reindex(app.id);
      setNotice(`Re-indexed ✓ — ${r.embedded} chunks embedded. Interviews now ground in this tailored resume.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={label} width="max-w-3xl">
      <div className="space-y-5">
        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-300">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!!busy} onClick={() => void downloadPdf()}>
            {busy === 'Exporting PDF…' ? 'Exporting…' : 'Download PDF'}
          </Button>
          <Button
            variant="ghost"
            disabled={!!busy}
            title="Re-embed the tailored resume + JD for live-interview grounding"
            onClick={() => void reindex()}
          >
            {busy === 'Re-indexing…' ? 'Re-indexing…' : 'Re-index'}
          </Button>
          {confirmDelete ? (
            <>
              <span className="text-xs text-neutral-500">
                Delete this application (and its tailored grounding)?
              </span>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={!!busy} onClick={() => void doDelete()}>
                Delete
              </Button>
            </>
          ) : (
            <Button variant="ghost" className="text-red-300" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>

        {/* The tailored, ATS-friendly resume. */}
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h4 className="text-sm font-semibold text-neutral-200">Tailored resume</h4>
            <Badge tone="green">ATS-friendly</Badge>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-neutral-950/40 p-4 text-sm leading-relaxed">
            <Markdown>{app.tailoredResume}</Markdown>
          </div>
        </section>

        {/* Grounded answers to the application's questions. */}
        {app.answers.length > 0 && (
          <section>
            <h4 className="mb-2 text-sm font-semibold text-neutral-200">Application answers</h4>
            <div className="space-y-3">
              {app.answers.map((a, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-neutral-950/40 p-3">
                  <p className="text-sm font-medium text-blue-200">{a.question}</p>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-300">{a.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="text-xs text-neutral-500">
          Tailored only from your base resume — nothing invented. “Start interview” from the
          applications table grounds the live session in this tailored resume + the JD.
        </p>
      </div>
    </Modal>
  );
}
