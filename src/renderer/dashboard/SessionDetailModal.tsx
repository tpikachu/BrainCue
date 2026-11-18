import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { activity as activityConfig } from '@shared/activities';
import { cloudProvider } from '@shared/providers';
import type { SessionDetail, SessionListItem, SessionReport } from '@shared/types';
import { durationMs, fmtDur } from '../lib/format';
import { useReadiness, useReadinessStore } from '../store/useReadiness';
import { Button, Modal, Spinner } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { sessionTimeline, type TimelineItem } from './sessionTimeline';

/** Rendered at once; the rest is one click away (a long call has thousands). */
const FIRST = 300;

/**
 * One saved session, readable on its own: the transcript in capture order,
 * each detected question with what BrainCue suggested (marked as generated,
 * never as said), and the other cards it produced — all from the local
 * database (`session:get`), so it opens with no API key, no report and no
 * network request.
 *
 * Coaching (interviews) and the meeting report are separate, explicit
 * actions: a report that is missing, or fails, leaves the conversation
 * readable above it.
 */
export function SessionDetailModal(props: {
  session: SessionListItem | null;
  onClose: () => void;
  /** Continue this interview — through the start flow (setup, disclosure). */
  onResume?: (s: SessionListItem) => void;
  canResume?: boolean;
  onDelete?: (s: SessionListItem) => Promise<void>;
  /** Open the meeting report (meetings only; generated on request). */
  onMeetingReport?: (s: SessionListItem) => void;
}) {
  const s = props.session;
  const readiness = useReadiness();
  const refreshReadiness = useReadinessStore((st) => st.refresh);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const forId = useRef<string | null>(null);

  useEffect(() => {
    forId.current = s?.id ?? null;
    setDetail(null);
    setLoadError(null);
    setShowAll(false);
    setReport(null);
    setReportError(null);
    setConfirmDelete(false);
    if (!s) return;
    const id = s.id;
    void refreshReadiness(); // a local read: who a report would be sent to
    // The ONLY session request on open: the persisted session, from this machine.
    void api.session
      .get(id)
      .then((d) => {
        if (forId.current !== id) return;
        const det = d as SessionDetail;
        setDetail(det);
        setReport(det.report);
      })
      .catch((e) => forId.current === id && setLoadError((e as Error).message));
  }, [s, refreshReadiness]);

  const items = useMemo(() => (detail ? sessionTimeline(detail) : []), [detail]);
  const shown = showAll ? items : items.slice(0, FIRST);
  const coachable = !!s && (s.mode === 'interview' || s.mode === 'practice');
  const parsing = readiness?.routes.parsing ? (cloudProvider(readiness.routes.parsing)?.name ?? readiness.routes.parsing) : null;
  const turns = detail?.transcript.length ?? 0;
  const questions = detail?.questions.length ?? 0;

  const generate = async () => {
    if (!s) return;
    const id = s.id;
    setReporting(true);
    setReportError(null);
    try {
      const r = (await api.session.generateReport(id)) as SessionReport;
      if (forId.current === id) setReport(r);
    } catch (e) {
      if (forId.current === id) setReportError((e as Error).message);
    } finally {
      setReporting(false);
    }
  };

  const del = async () => {
    if (!s || !props.onDelete) return;
    setDeleting(true);
    try {
      await props.onDelete(s);
    } catch (e) {
      setLoadError(`It was not deleted (${(e as Error).message}).`);
    } finally {
      setDeleting(false);
    }
  };

  const title = s ? s.jobCompany || s.jobTitle || detail?.spaceCompany || detail?.spaceTitle || 'Session' : 'Session';
  const kindLabel = s?.activity ? activityConfig(s.activity).label : s?.mode === 'meeting' ? 'Meeting' : s?.mode === 'companion' ? 'Companion' : 'Interview';

  return (
    <Modal open={!!s} onClose={props.onClose} title={`${title} · ${kindLabel}`} width="max-w-3xl" busy={deleting ? 'Deleting' : reporting ? 'Writing the coaching report' : false}>
      {s && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
            <span>{new Date(s.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>· {fmtDur(durationMs(s))}</span>
            {detail && (
              <span>
                · {turns} turn{turns === 1 ? '' : 's'}
                {questions > 0 && ` · ${questions} question${questions === 1 ? '' : 's'}`}
              </span>
            )}
            {s.kind === 'sparring' && <span>· practice</span>}
            <span className="flex-1" />
            {props.onResume && (
              <Button variant="success" disabled={!props.canResume} title={props.canResume ? undefined : 'Stop the live session first.'} onClick={() => props.onResume!(s)}>
                Resume
              </Button>
            )}
            {s.mode === 'meeting' && props.onMeetingReport && (
              <Button variant="default" onClick={() => props.onMeetingReport!(s)}>
                Meeting report
              </Button>
            )}
            {props.onDelete && (
              <Button variant="ghost" className="text-red-300" onClick={() => setConfirmDelete(true)}>
                Delete…
              </Button>
            )}
          </div>

          {confirmDelete && (
            <div role="alertdialog" aria-label="Delete this session?" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-100">
              <span>Delete this session, its transcript and anything it suggested? This cannot be undone.</span>
              <span className="flex gap-2">
                <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button variant="danger" loading={deleting} onClick={() => void del()}>
                  Delete it
                </Button>
              </span>
            </div>
          )}

          {/* The conversation — what was said, and what BrainCue suggested. */}
          <section aria-label="Conversation">
            {loadError ? (
              <p className="text-amber-400" role="alert">
                ⚠ {loadError}
              </p>
            ) : !detail ? (
              <p className="flex items-center gap-2 py-4 text-neutral-400">
                <Spinner className="h-4 w-4" /> Opening…
              </p>
            ) : items.length === 0 ? (
              <p className="py-2 text-neutral-500">No transcript was captured in this session.</p>
            ) : (
              <ol className="max-h-[55vh] space-y-2 overflow-y-auto rounded-xl border border-white/5 bg-neutral-950/40 p-3">
                {shown.map((it) => (
                  <TimelineRow key={`${it.kind}:${it.id}`} item={it} />
                ))}
                {!showAll && items.length > FIRST && (
                  <li>
                    <Button variant="ghost" onClick={() => setShowAll(true)}>
                      Show all {items.length}
                    </Button>
                  </li>
                )}
              </ol>
            )}
          </section>

          {/* Coaching: its own explicit step. Missing or failing, it never
              hides the conversation above. */}
          {coachable && detail && (
            <section aria-label="Coaching report" className="space-y-2 border-t border-white/5 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium text-neutral-200">Coaching report</h4>
                {!reporting && (
                  <Button variant={report ? 'ghost' : 'primary'} disabled={turns === 0} onClick={() => void generate()}>
                    {report ? 'Write it again' : 'Write a coaching report'}
                  </Button>
                )}
              </div>
              {reporting ? (
                <p className="flex items-center gap-2 text-neutral-400">
                  <Spinner className="h-4 w-4" /> Writing the report…
                </p>
              ) : reportError ? (
                <p className="text-amber-400" role="alert">
                  ⚠ The report could not be written ({reportError}). The conversation above is unaffected.
                </p>
              ) : report ? (
                <ReportView report={report} />
              ) : (
                <p className="text-xs text-neutral-500">
                  {turns === 0
                    ? 'Nothing was captured to coach.'
                    : `Not written yet. Writing one sends the transcript${parsing ? ` to ${parsing}` : ''}.`}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.kind === 'turn') {
    return (
      <li className="leading-snug">
        <span className={`mr-1.5 text-xs font-medium ${item.who === 'you' ? 'text-emerald-300' : 'text-neutral-400'}`}>{item.label}</span>
        <span className="text-neutral-200">{item.text}</span>
      </li>
    );
  }
  if (item.kind === 'suggestion') {
    return (
      <li className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
        <p className="text-xs text-indigo-300">
          <span className="font-medium">{item.asked ? 'You asked:' : 'Question detected:'}</span> {item.question}
        </p>
        {item.answer ? (
          <div className="mt-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-300/70">Suggested by BrainCue — not said</p>
            <div className="text-neutral-300">
              <Markdown>{item.answer}</Markdown>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-neutral-500">Not answered{item.note ? ` — ${item.note}` : '.'}</p>
        )}
        {item.answer && item.note && <p className="mt-1 text-xs text-amber-300/80">⚠ {item.note}</p>}
      </li>
    );
  }
  return (
    <li className="rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {item.cardKind.replace(/_/g, ' ')} · generated
      </p>
      {item.title && <p className="text-neutral-200">{item.title}</p>}
      {item.body && (
        <div className="text-neutral-300">
          <Markdown>{item.body}</Markdown>
        </div>
      )}
    </li>
  );
}

function ReportView({ report }: { report: SessionReport }) {
  return (
    <div className="space-y-3">
      <Markdown>{report.summary}</Markdown>
      {report.strengths.length > 0 && <ReportList title="Strengths" tone="text-green-300" items={report.strengths} />}
      {report.improvements.length > 0 && <ReportList title="Improvements" tone="text-amber-300" items={report.improvements} />}
      {report.perQuestion.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-neutral-300">Per question</p>
          <ul className="space-y-2">
            {report.perQuestion.map((q, i) => (
              <li key={i} className="rounded-lg bg-neutral-950/60 p-2">
                <p className="text-neutral-300">{q.question}</p>
                <p className="text-neutral-500">{q.assessment}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReportList({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  return (
    <div>
      <p className={`mb-1 font-medium ${tone}`}>{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-neutral-300">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
