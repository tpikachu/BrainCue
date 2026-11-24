import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { activity as activityConfig } from '@shared/activities';
import { useProfileStore } from '../../store/useProfileStore';
import { useLiveSession } from '../../store/useLiveSession';
import type { SessionListItem } from '@shared/types';
import { durationMs, fmtDur } from '../../lib/format';
import { Badge, Button, Page } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { MeetingReportModal } from '../MeetingReportModal';
import { SessionDetailModal } from '../SessionDetailModal';
import { StartSessionModal } from '../StartSessionModal';
import { isResumableInterview } from '../startFlow';

const PER_PAGE = 12;

/** Session history — every saved session of the active profile, newest first,
 *  one server-side page at a time (it only grows). Opening one shows what was
 *  said and suggested, straight from this machine; reports are a separate,
 *  explicit step inside it. */
export default function SessionsPage() {
  // Sessions are a view of the ACTIVE profile — this page used to list every
  // session in the database, including other people's conversations.
  const profileId = useProfileStore((s) => s.activeId);
  const live = useLiveSession();
  const [rows, setRows] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reloads, setReloads] = useState(0);
  const [openSession, setOpenSession] = useState<SessionListItem | null>(null);
  const [meetingSession, setMeetingSession] = useState<SessionListItem | null>(null);
  const [resumeFor, setResumeFor] = useState<SessionListItem | null>(null);
  const seq = useRef(0);

  // A profile switch starts the list over.
  useEffect(() => {
    setPage(0);
    setQuery('');
    setOpenSession(null);
  }, [profileId]);

  // The current page (debounced while typing). A reply for an earlier
  // request — another profile, page or query — is dropped.
  useEffect(() => {
    if (!profileId) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(
      () =>
        void api.session
          .page(profileId, query.trim(), PER_PAGE, page * PER_PAGE)
          .then((r) => {
            if (n !== seq.current) return;
            setRows(r.items);
            setTotal(r.total);
          })
          .catch(() => n === seq.current && (setRows([]), setTotal(0)))
          .finally(() => n === seq.current && setLoading(false)),
      query ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [profileId, query, page, reloads, live.pendingSave, live.session]);

  const del = async (s: SessionListItem) => {
    await api.session.delete(s.id);
    if (openSession?.id === s.id) setOpenSession(null);
    setReloads((n) => n + 1);
  };

  const columns: Column<SessionListItem>[] = [
    {
      key: 'interview',
      header: 'Space',
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-neutral-100">{s.jobCompany || s.jobTitle || 'No Space'}</div>
          {s.jobCompany && s.jobTitle && <div className="truncate text-xs text-neutral-500">{s.jobTitle}</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      className: 'w-40',
      render: (s) => {
        const n = Object.values(s.typeCounts).reduce((a, b) => a + b, 0);
        const breakdown = Object.entries(s.typeCounts)
          .map(([t, c]) => `${t.replace(/_/g, ' ')} ×${c}`)
          .join(' · ');
        return (
          <div className="flex flex-col gap-0.5" title={breakdown || undefined}>
            <span className="flex items-center gap-1">
              {/* What the user said it was. The mode is only what we derived
                  from it, and several activities share one. */}
              {s.activity ? (
                <Badge tone={s.mode === 'meeting' ? 'blue' : s.mode === 'companion' ? 'green' : undefined}>
                  {activityConfig(s.activity).label}
                </Badge>
              ) : s.mode === 'meeting' ? (
                <Badge tone="blue">Meeting</Badge>
              ) : s.mode === 'companion' ? (
                <Badge tone="green">Companion</Badge>
              ) : (
                <Badge>{s.interviewType.replace(/_/g, ' ')}</Badge>
              )}
              {s.kind === 'sparring' && <Badge tone="amber">Practice</Badge>}
            </span>
            {n > 0 && <span className="text-[11px] text-neutral-500">{n} questions</span>}
          </div>
        );
      },
    },
    {
      key: 'when',
      header: 'When',
      className: 'w-44',
      render: (s) => (
        <div className="text-xs text-neutral-400">
          <div>{new Date(s.createdAt).toLocaleDateString()}</div>
          <div className="text-neutral-500">
            {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {fmtDur(durationMs(s))}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-28 text-right',
      render: (s) => (
        <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" onClick={() => setOpenSession(s)}>
            Open
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Page title="Sessions" subtitle="Every saved session, newest first. Open one to read what was said and suggested.">
      <div data-tour="sessions-table">
        <DataTable<SessionListItem>
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          total={total}
          page={page}
          pageSize={PER_PAGE}
          onPage={setPage}
          query={query}
          onQuery={(q) => {
            setQuery(q);
            setPage(0);
          }}
          searchPlaceholder="Search by Space, role, or session type…"
          onRowClick={(s) => setOpenSession(s)}
          loading={loading}
          empty="No sessions yet. Start one from Home and save it when you stop."
        />
      </div>

      <SessionDetailModal
        session={openSession}
        onClose={() => setOpenSession(null)}
        onDelete={del}
        onResume={openSession && isResumableInterview(openSession) ? (s) => {
          setOpenSession(null);
          setResumeFor(s);
        } : undefined}
        canResume={!live.session}
        onMeetingReport={(s) => {
          setOpenSession(null);
          setMeetingSession(s);
        }}
      />

      {/* Resume goes through the ONE start flow: setup, readiness and the
          processing disclosure, before anything is captured. */}
      <StartSessionModal open={!!resumeFor} onClose={() => setResumeFor(null)} resume={resumeFor ?? undefined} />

      {/* Meeting report (structured; action items/open questions editable) —
          generated only when asked for, from the session detail. */}
      <MeetingReportModal session={meetingSession} onClose={() => setMeetingSession(null)} />
    </Page>
  );
}
