import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import type { Job } from '@shared/types';
import { Badge, Button, Card, Field, Select } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { JobFormModal } from '../JobFormModal';
import { BriefModal } from '../BriefModal';
import { StartSessionModal } from '../StartSessionModal';
import { PlayIcon, PlusIcon } from '../../components/icons';
import { FLAGS } from '@shared/flags';

const PER_PAGE = 8;

/** Library › Spaces: the contexts BrainCue grounds itself in. Today every
 *  Space is an interview/job Space (the v1 "jobs" — JD, company research,
 *  notes, briefs); other kinds arrive with their modes. Managing them lives
 *  here; STARTING a session is the shared start flow. Tailor Resume is a
 *  job-Space action (not a universal top-level concept). */
export function SpacesTab() {
  const navigate = useNavigate();
  const { profiles, load } = useProfileStore();
  const [profileId, setProfileId] = useState('');

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
    void load();
  }, [load]);

  // Default to the first profile so the list isn't empty behind a hidden picker.
  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

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
          <div className="font-medium text-neutral-100">{j.title || 'Untitled role'}</div>
          {j.company && <div className="text-xs text-neutral-500">{j.company}</div>}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      className: 'w-28',
      render: () => <Badge>Interview</Badge>,
    },
    {
      key: 'docs',
      header: 'Context',
      className: 'w-36',
      render: (j) => (
        <div className="flex flex-wrap gap-1.5">
          {j.parsedJd ? <Badge tone="green">JD ✓</Badge> : <Badge tone="amber">no JD</Badge>}
          {j.parsedCompany && <Badge tone="blue">company ✓</Badge>}
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
          <Button
            variant="ghost"
            disabled={!j.parsedJd}
            title={j.parsedJd ? 'Pre-interview prep brief' : 'Add a job description first'}
            onClick={() => setBriefJob(j)}
          >
            Brief
          </Button>
          {FLAGS.jobSearch && (
            <Button
              variant="ghost"
              title="Tailor your résumé to this Space's job description"
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
        A Space is everything BrainCue should know for one context — for interviews: the job
        description, company research, and your notes. Answers ground themselves in the active
        Space.
      </p>

      <Card className="mb-5">
        <Field label="Profile">
          <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">Select a profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.targetRole ? ` · ${p.targetRole}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

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
            searchPlaceholder="Search Spaces by role or company…"
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
        initialProfileId={profileId}
        initialSpaceId={startSpaceId ?? undefined}
      />
    </div>
  );
}
