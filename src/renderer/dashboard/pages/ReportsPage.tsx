import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { SessionListItem, SessionReport } from '@shared/types';
import { Badge, Button, Card, Page, Pager, SearchInput, Spinner } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

const GROUPS_PER_PAGE = 4;

interface Group {
  company: string;
  sessions: SessionListItem[];
  latest: number;
}

export default function ReportsPage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const refresh = async () => setSessions((await api.session.list()) as SessionListItem[]);

  useEffect(() => {
    void refresh();
  }, []);

  // Filter → group by company (one job can have many interview rounds).
  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) =>
          `${s.jobCompany ?? ''} ${s.jobTitle ?? ''} ${s.profileName ?? ''} ${s.interviewType}`
            .toLowerCase()
            .includes(q),
        )
      : sessions;

    const map = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const key = s.jobCompany || s.jobTitle || 'General / no job';
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()]
      .map(([company, list]) => ({
        company,
        sessions: list,
        latest: Math.max(...list.map((s) => s.createdAt)),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [sessions, query]);

  const totalPages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const pageGroups = groups.slice(safePage * GROUPS_PER_PAGE, safePage * GROUPS_PER_PAGE + GROUPS_PER_PAGE);

  const view = async (id: string) => {
    setOpenId(id);
    setLoadingReport(true);
    setReport(null);
    setReportError(null);
    try {
      let r = (await api.session.getReport(id)) as SessionReport | null;
      if (!r) r = (await api.session.generateReport(id)) as SessionReport;
      setReport(r);
    } catch (e) {
      setReportError((e as Error).message);
    } finally {
      setLoadingReport(false);
    }
  };

  const del = async (id: string) => {
    await api.session.delete(id);
    if (openId === id) {
      setOpenId(null);
      setReport(null);
    }
    await refresh();
  };

  return (
    <Page
      title="Reports"
      subtitle="Interviews grouped by company. Each company can have several rounds."
    >
      {sessions.length > 0 && (
        <div className="mb-4">
          <SearchInput
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search by company, role, profile, or interview type…"
          />
        </div>
      )}

      {sessions.length === 0 && (
        <p className="py-8 text-center text-sm text-neutral-500">No sessions recorded yet.</p>
      )}
      {sessions.length > 0 && groups.length === 0 && (
        <p className="py-8 text-center text-sm text-neutral-500">Nothing matches your search.</p>
      )}

      <div className="space-y-6">
        {pageGroups.map((g) => (
          <div key={g.company}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-neutral-200">{g.company}</h3>
              <Badge>{g.sessions.length} round{g.sessions.length > 1 ? 's' : ''}</Badge>
            </div>
            <div className="space-y-2">
              {g.sessions.map((s) => (
                <Card key={s.id} className="!py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium capitalize">
                        {s.interviewType.replace('_', ' ')}
                        {s.jobTitle ? ` · ${s.jobTitle}` : ''}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
                        <Badge tone={s.status === 'live' ? 'green' : 'neutral'}>{s.status}</Badge>
                        {s.profileName && <span>{s.profileName}</span>}
                        <span>{new Date(s.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => view(s.id)}>
                        {openId === s.id ? 'Refresh' : 'Report'}
                      </Button>
                      <Button variant="ghost" className="text-red-300" onClick={() => del(s.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>

                  {openId === s.id && (
                    <div className="mt-4 border-t border-neutral-800 pt-4 text-sm">
                      {loadingReport ? (
                        <div className="flex items-center gap-2 text-neutral-400">
                          <Spinner className="h-4 w-4" /> Generating report…
                        </div>
                      ) : reportError ? (
                        <p className="text-red-300">{reportError}</p>
                      ) : report ? (
                        <div className="space-y-3">
                          <Markdown>{report.summary}</Markdown>
                          {report.strengths.length > 0 && (
                            <ReportList title="Strengths" tone="text-green-300" items={report.strengths} />
                          )}
                          {report.improvements.length > 0 && (
                            <ReportList
                              title="Improvements"
                              tone="text-amber-300"
                              items={report.improvements}
                            />
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
                        <p className="text-neutral-500">No report available.</p>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        ))}
        <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
      </div>
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
