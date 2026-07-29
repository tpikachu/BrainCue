import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import type { Job } from '@shared/types';
import { Badge, Button, Card } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { JobFormModal } from '../JobFormModal';
import { BriefModal } from '../BriefModal';
import { StartSessionModal } from '../StartSessionModal';
import { PlayIcon, PlusIcon } from '../../components/icons';
import { FLAGS } from '@shared/flags';
import { activity, isInterviewSpace } from '@shared/activities';

const PER_PAGE = 8;

/** Library › Spaces: the contexts BrainCue grounds itself in. Today every
 *  Space is an interview/job Space (the v1 "jobs" — JD, company research,
 *  notes, briefs); other kinds arrive with their modes. Managing them lives
 *  here; STARTING a session is the shared start flow. Tailor Resume is a
 *  job-Space action (not a universal top-level concept). */
export function SpacesTab() {
  const navigate = useNavigate();
  // Whose Spaces these are is decided once, in the sidebar switcher.
  const profileId = useProfileStore((s) => s.activeId) ?? '';

  const [rows, setRows] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editJob, setEditJob] = useState<Job | null>(null); // null => create
  const [briefJob, setBriefJob] = useState<Job | null>(null);
  const [startSpaceId, setStartSpaceId] = useState<string | null>(null); // open => start flow

  useEffect(() => {
    setPage(0);
    setQuery('');
  }, [profileId]);

  const fetchPage = () => {
    setLoading(true);
    void api.jobs
      .page(profileId, query.trim(), PER_PAGE, page * PER_PAGE)
      .then(({ items, total }) => {
        setRows(items as Job[]);
        setTotal(total);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!profileId) {
      setRows([]);
      setTotal(0);
      return;
    }
    const t = setTimeout(fetchPage, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, query, page]);

  const columns: Column<Job>[] = [
    {
      key: 'title',
      header: 'Space',
      render: (j) => (
        <div>
          <div className="font-medium text-neutral-100">{j.title || 'Untitled'}</div>
          {j.company && <div className="text-xs text-neutral-500">{j.company}</div>}
        </div>
      ),
    },
    {
      // There used to be a "Kind" column here that rendered the literal string
      // "Interview" for every row — v1 residue from when a Space could only be
      // a job. It sat next to the column that shows the REAL activity, so a
      // standup read as "Kind: Interview · Meeting or call".
      key: 'activity',
      header: 'Activity',
      className: 'w-44',
      render: (j) => (
        <div className="flex flex-wrap gap-1.5">
          <Badge>{activity(j.kind).label}</Badge>
          {/* "Parsed" is only meaningful for an interview; other kinds index
              their document as plain text, so show whether there IS one. */}
          {isInterviewSpace(j.kind) ? (
            j.parsedJd ? (
              <Badge tone="green">JD ✓</Badge>
            ) : (
              <Badge tone="amber">no JD</Badge>
            )
          ) : (
            j.jdText && <Badge tone="green">context ✓</Badge>
          )}
          {j.parsedCompany && <Badge tone="blue">link read ✓</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-80 text-right',
      render: (j) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="success" onClick={() => setStartSpaceId(j.id)} title="Start a session in this Space">
            <PlayIcon /> Start
          </Button>
          {/* A prep brief predicts interview questions against a JD — it has no
              meaning for a standup or a project. */}
          {isInterviewSpace(j.kind) && (
            <Button
              variant="ghost"
              disabled={!j.parsedJd}
              title={j.parsedJd ? 'Pre-interview prep brief' : 'Add a job description first'}
              onClick={() => setBriefJob(j)}
            >
              Brief
            </Button>
          )}
          {/* Same kind gate as Brief above: only a job Space HAS a job
              description to tailor against. The title no longer claims this
              Space's JD is carried over — `navigate('/tailor')` passes no id,
              and Tailor cannot attach an application to an existing Space at
              all (docs/20-QUARANTINE.md). Promising it was the bug. */}
          {FLAGS.jobSearch && isInterviewSpace(j.kind) && (
            <Button
              variant="ghost"
              title="Open Tailor Resume (you'll paste the job description there)"
              onClick={() => navigate('/tailor')}
            >
              Tailor
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setEditJob(j);
              setFormOpen(true);
            }}
          >
            Detail
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <p className="mb-4 text-sm text-neutral-400">
        A Space is everything BrainCue should know for one recurring context — a meeting, a
        project, a subject, an interview. Its activity decides what it asks you for; answers,
        archives, and memory from a session all attach to the Space it ran in.
      </p>

      {profileId && (
        <Card>
          <DataTable<Job>
            columns={columns}
            rows={rows}
            rowKey={(j) => j.id}
            total={total}
            page={page}
            pageSize={PER_PAGE}
            onPage={setPage}
            query={query}
            onQuery={(q) => {
              setQuery(q);
              setPage(0);
            }}
            searchPlaceholder="Search Spaces by name or who they involve…"
            onRowClick={(j) => {
              setEditJob(j);
              setFormOpen(true);
            }}
            loading={loading}
            empty="No Spaces yet. Create one with a job description — it's saved and reused for every session in that context."
            actions={
              <Button
                variant="primary"
                onClick={() => {
                  setEditJob(null);
                  setFormOpen(true);
                }}
              >
                <PlusIcon /> New Space
              </Button>
            }
          />
        </Card>
      )}

      <JobFormModal
        open={formOpen}
        profileId={profileId}
        job={editJob}
        onClose={() => setFormOpen(false)}
        onSaved={(job) => {
          setEditJob(job);
          fetchPage();
        }}
        onDeleted={() => fetchPage()}
      />
      <BriefModal open={!!briefJob} job={briefJob} onClose={() => setBriefJob(null)} />
      <StartSessionModal
        open={!!startSpaceId}
        onClose={() => setStartSpaceId(null)}
        initialSpaceId={startSpaceId ?? undefined}
      />
    </div>
  );
}
