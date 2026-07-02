import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useLiveSession } from '../store/useLiveSession';
import type { Application } from '@shared/types';
import { Badge, Button, Modal } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { wordDiff, type DiffSegment } from '../lib/wordDiff';

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
  const [compare, setCompare] = useState(false); // side-by-side base vs tailored
  const { session } = useLiveSession();
  const isLive = !!app && session?.jobId === app.jobId; // a live interview grounds in this app

  // Reset transient state whenever a different application (or none) is shown.
  useEffect(() => {
    setBusy(null);
    setNotice(null);
    setError(null);
    setConfirmDelete(false);
    setCompare(false);
  }, [open, app?.id]);

  // Word-level diff, computed only when comparing. Null = too large → plain panes.
  const diff = useMemo(
    () => (compare && app ? wordDiff(app.baseResume, app.tailoredResume) : null),
    [compare, app],
  );

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
            title="See what changed against your base resume"
            onClick={() => setCompare((v) => !v)}
          >
            {compare ? 'Hide comparison' : 'Compare with base'}
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
            <Button
              variant="ghost"
              className="text-red-300"
              disabled={isLive}
              title={isLive ? 'A live interview is using this application — stop it first' : undefined}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>

        {/* The tailored, ATS-friendly resume — or a base-vs-tailored comparison. */}
        {compare ? (
          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h4 className="text-sm font-semibold text-neutral-200">Base vs tailored</h4>
              {diff ? (
                <span className="text-xs text-neutral-600">
                  <span className="rounded-sm bg-red-500/25 px-1 text-red-200">removed</span> ·{' '}
                  <span className="rounded-sm bg-green-500/25 px-1 text-green-200">added / rewritten</span>
                </span>
              ) : (
                <span className="text-xs text-neutral-600">too long to highlight — shown side by side</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DiffPane title="Base resume" segs={diff?.base} fallback={app.baseResume} />
              <DiffPane title="Tailored" segs={diff?.revised} fallback={app.tailoredResume} />
            </div>
          </section>
        ) : (
          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h4 className="text-sm font-semibold text-neutral-200">Tailored resume</h4>
              <Badge tone="green">ATS-friendly</Badge>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-neutral-950/40 p-4 text-sm leading-relaxed">
              <Markdown>{app.tailoredResume}</Markdown>
            </div>
          </section>
        )}

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

/** One side of the base-vs-tailored comparison: highlighted diff segments when
 *  available, otherwise the plain text (inputs too large to diff). */
function DiffPane({
  title,
  segs,
  fallback,
}: {
  title: string;
  segs: DiffSegment[] | undefined;
  fallback: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-neutral-500">{title}</div>
      <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-neutral-950/40 p-3 text-xs leading-relaxed text-neutral-300">
        {segs
          ? segs.map((s, i) =>
              s.op === 'same' ? (
                <span key={i}>{s.text}</span>
              ) : (
                <span
                  key={i}
                  className={
                    s.op === 'del'
                      ? 'rounded-sm bg-red-500/25 text-red-200'
                      : 'rounded-sm bg-green-500/25 text-green-200'
                  }
                >
                  {s.text}
                </span>
              ),
            )
          : fallback}
      </div>
    </div>
  );
}
