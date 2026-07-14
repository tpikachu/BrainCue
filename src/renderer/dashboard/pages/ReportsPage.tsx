import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { PracticeStats, SessionListItem, SessionReport } from '@shared/types';
import { Badge, Button, Card, Modal, Page, Spinner } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { Markdown } from '../../components/Markdown';

const PER_PAGE = 12;

/** A session's elapsed time (live sessions count up to now). */
function durationMs(s: SessionListItem): number {
  if (!s.startedAt) return 0;
  return Math.max(0, (s.endedAt ?? Date.now()) - s.startedAt);
}
function fmtDur(ms: number): string {
  if (ms < 1000) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
function fmtHours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export default function ReportsPage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [practice, setPractice] = useState<PracticeStats | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  // Report modal.
  const [openSession, setOpenSession] = useState<SessionListItem | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setSessions((await api.session.list()) as SessionListItem[]);
      setPractice((await api.session.practiceStats()) as PracticeStats);
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
      header: 'Interview',
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-neutral-100">
            {s.jobCompany || s.jobTitle || 'General / no job'}
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
              <Badge>{s.interviewType.replace(/_/g, ' ')}</Badge>
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
      title="Reports"
      subtitle="Every interview session, newest first. Open one for a coaching report."
    >
      {practice && practice.answers > 0 && <PracticeCard stats={practice} />}

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
        searchPlaceholder="Search by client, role, profile, or interview type…"
        onRowClick={(s) => view(s)}
        loading={loading}
        empty="No interview sessions yet. Start one from the Interview page and save it when you stop."
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
    </Page>
  );
}

/** The Practice Loop summary: overall average, a per-drill trend, and the
 *  per-competency averages — all from persisted sparring coaching. Single-hue
 *  magnitude visuals (indigo accent on the app surface); values are shown as
 *  text so nothing depends on color alone. */
function PracticeCard({ stats }: { stats: PracticeStats }) {
  const trend = stats.recent;
  // Fixed, honest 0–5 domain for both the sparkline and the bar lengths.
  const W = 220;
  const H = 48;
  const PAD = 6;
  const x = (i: number) => (trend.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (trend.length - 1));
  const y = (v: number) => H - PAD - ((v / 5) * (H - PAD * 2));
  const points = trend.map((d, i) => `${x(i).toFixed(1)},${y(d.avgRating).toFixed(1)}`).join(' ');

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h3 className="font-medium text-neutral-100">Practice</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {stats.sessions} drill{stats.sessions === 1 ? '' : 's'} · {stats.answers} answer
            {stats.answers === 1 ? '' : 's'} coached
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-neutral-100">
            {stats.avgRating.toFixed(1)}
            <span className="ml-1 text-base font-normal text-neutral-500">/ 5 average</span>
          </p>
          {trend.length > 1 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                Per-drill average
              </p>
              <svg width={W} height={H} role="img" aria-label="Average rating per practice drill">
                <polyline
                  points={points}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {trend.map((d, i) => (
                  <circle key={d.sessionId} cx={x(i)} cy={y(d.avgRating)} r="3" fill="#818cf8">
                    <title>
                      {new Date(d.createdAt).toLocaleDateString()} — {d.avgRating.toFixed(1)}/5 (
                      {d.answers} answer{d.answers === 1 ? '' : 's'})
                    </title>
                  </circle>
                ))}
              </svg>
            </div>
          )}
        </div>

        {stats.byCompetency.length > 0 && (
          <div className="min-w-[16rem] flex-1">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">
              By competency
            </p>
            <ul className="space-y-1.5">
              {stats.byCompetency.slice(0, 6).map((c) => (
                <li key={c.competency} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 truncate text-neutral-300">
                    {c.competency.replace(/_/g, ' ')}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <span
                      className="block h-full rounded-full bg-indigo-400"
                      style={{ width: `${(c.avgRating / 5) * 100}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-neutral-300">
                    {c.avgRating.toFixed(1)}
                    <span className="text-neutral-600"> ×{c.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
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
