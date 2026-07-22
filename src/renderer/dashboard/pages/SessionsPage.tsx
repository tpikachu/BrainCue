import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { SessionListItem, SessionReport } from '@shared/types';
import { durationMs, fmtDur, fmtHours } from '../../lib/format';
import { Badge, Button, Modal, Page, Spinner } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { Markdown } from '../../components/Markdown';
import { MeetingReportModal } from '../MeetingReportModal';

const PER_PAGE = 12;

/** Session history — every saved session across modes, newest first, with the
 *  per-session coaching report. (Split out of Reports, which is now the
 *  aggregate Insights view.) */
export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  // Report modals (interview coaching vs meeting report, by session mode).
  const [openSession, setOpenSession] = useState<SessionListItem | null>(null);
  const [meetingSession, setMeetingSession] = useState<SessionListItem | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setSessions((await api.session.list()) as SessionListItem[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${s.jobCompany ?? ''} ${s.jobTitle ?? ''} ${s.profileName ?? ''} ${s.interviewType}`
        .toLowerCase()
        .includes(q),
    );
  }, [sessions, query]);

  const totalMs = useMemo(() => filtered.reduce((n, s) => n + durationMs(s), 0), [filtered]);
  const pageRows = filtered.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  const view = async (s: SessionListItem) => {
    // Meetings have their own structured report (summary/decisions/actions).
    if (s.mode === 'meeting') {
      setMeetingSession(s);
      return;
    }
    setOpenSession(s);
    setReport(null);
    setReportError(null);
    setLoadingReport(true);
    try {
      let r = (await api.session.getReport(s.id)) as SessionReport | null;
      if (!r) r = (await api.session.generateReport(s.id)) as SessionReport;
      setReport(r);
    } catch (e) {
      setReportError((e as Error).message);
    } finally {
      setLoadingReport(false);
    }
  };

  const del = async (id: string) => {
    await api.session.delete(id);
    if (openSession?.id === id) setOpenSession(null);
    await refresh();
  };

  const columns: Column<SessionListItem>[] = [
    {
      key: 'interview',
      header: 'Space',
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-neutral-100">
            {s.jobCompany || s.jobTitle || 'General / no Space'}
          </div>
          {s.jobCompany && s.jobTitle && (
            <div className="truncate text-xs text-neutral-500">{s.jobTitle}</div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      className: 'w-40',
      render: (s) => {
        const total = Object.values(s.typeCounts).reduce((a, b) => a + b, 0);
        const breakdown = Object.entries(s.typeCounts)
          .map(([t, n]) => `${t.replace(/_/g, ' ')} ×${n}`)
          .join(' · ');
        return (
          <div className="flex flex-col gap-0.5" title={breakdown}>
            <span className="flex items-center gap-1">
              {s.mode === 'meeting' ? (
                <Badge tone="blue">Meeting</Badge>
              ) : (
                <Badge>{s.interviewType.replace(/_/g, ' ')}</Badge>
              )}
              {s.kind === 'sparring' && <Badge tone="amber">Practice</Badge>}
            </span>
            {total > 0 && <span className="text-[11px] text-neutral-500">{total} questions</span>}
          </div>
        );
      },
    },
    {
      key: 'profile',
      header: 'Profile',
      className: 'w-36',
      render: (s) => <span className="text-sm text-neutral-300">{s.profileName ?? '—'}</span>,
    },
    {
      key: 'when',
      header: 'When',
      className: 'w-44',
      render: (s) => (
        <div className="text-xs text-neutral-400">
          <div>{new Date(s.createdAt).toLocaleDateString()}</div>
          <div className="text-neutral-500">
            {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
            {fmtDur(durationMs(s))}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-44 text-right',
      render: (s) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" onClick={() => view(s)}>
            Report
          </Button>
          <Button variant="ghost" className="text-red-300" onClick={() => del(s.id)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Page
      title="Sessions"
      subtitle="Every saved session, newest first. Open one for a coaching report."
    >
      {sessions.length > 0 && (
        <div className="mb-4 flex gap-3 text-sm text-neutral-400">
          <span>
            <span className="font-semibold text-neutral-200">{filtered.length}</span> sessions
          </span>
          <span className="text-neutral-600">·</span>
          <span>
            <span className="font-semibold text-neutral-200">{fmtHours(totalMs)}</span> total
          </span>
        </div>
      )}

      <DataTable<SessionListItem>
        columns={columns}
        rows={pageRows}
        rowKey={(s) => s.id}
        total={filtered.length}
        page={page}
        pageSize={PER_PAGE}
        onPage={setPage}
        query={query}
        onQuery={(q) => {
          setQuery(q);
          setPage(0);
        }}
        searchPlaceholder="Search by client, role, profile, or session type…"
        onRowClick={(s) => view(s)}
        loading={loading}
        empty="No sessions yet. Start one from Home and save it when you stop."
      />

      {/* Report detail */}
      <Modal
        open={!!openSession}
        onClose={() => setOpenSession(null)}
        title={
          openSession
            ? `${openSession.jobCompany || openSession.jobTitle || 'Session'} · ${openSession.interviewType.replace(/_/g, ' ')}`
            : 'Report'
        }
      >
        {loadingReport ? (
          <div className="flex items-center gap-2 py-6 text-neutral-400">
            <Spinner className="h-4 w-4" /> Generating report…
          </div>
        ) : reportError ? (
          <p className="text-sm text-red-300">{reportError}</p>
        ) : report ? (
          <div className="space-y-4 text-sm">
            <Markdown>{report.summary}</Markdown>
            {report.strengths.length > 0 && (
              <ReportList title="Strengths" tone="text-green-300" items={report.strengths} />
            )}
            {report.improvements.length > 0 && (
              <ReportList title="Improvements" tone="text-amber-300" items={report.improvements} />
            )}
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
        ) : (
          <p className="text-sm text-neutral-500">No report available.</p>
        )}
      </Modal>

      {/* Meeting report (structured; action items/open questions editable). */}
      <MeetingReportModal session={meetingSession} onClose={() => setMeetingSession(null)} />
    </Page>
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
