import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { usePagedSearch } from '../../lib/usePagedSearch';
import { Badge, Button, Card, Field, Page, Pager, SearchInput, TextInput } from '../../components/ui';
import { PlusIcon } from '../../components/icons';

export default function ProfilesPage() {
  const { profiles, load, create, remove } = useProfileStore();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadingSamples, setLoadingSamples] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // Seed a sample profile + Google/Amazon/Stripe interviews to try the flow.
  const loadSamples = async () => {
    setLoadingSamples(true);
    try {
      const res = await api.data.loadSamples();
      await load();
      navigate(`/profiles/${res.profileId}`);
    } finally {
      setLoadingSamples(false);
    }
  };

  const paged = usePagedSearch(profiles, (p) => `${p.name} ${p.targetRole}`, 8);

  const onCreate = async () => {
    if (!name) return;
    setCreating(true);
    try {
      const profile = await create({
        name,
        targetRole,
        targetCompany: null,
        interviewType: 'general',
        answerStyle: 'default',
        language: 'en',
        resumeText: null,
        jdText: null,
      });
      navigate(`/profiles/${profile.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Page
      title="Profiles"
      subtitle="A profile is just you: your name, role, and resume. Reuse it for every job."
      actions={
        <Button variant="ghost" onClick={loadSamples} loading={loadingSamples} title="Create a sample profile + Google/Amazon/Stripe interviews to try the app">
          Load sample data
        </Button>
      }
    >
      <Card className="mb-6">
        <h3 className="mb-4 font-medium">New profile</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jordan Lee" />
          </Field>
          <Field label="Your role / title">
            <TextInput
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="e.g. Senior Product Manager"
            />
          </Field>
        </div>
        <Button variant="primary" className="mt-4" onClick={onCreate} disabled={!name} loading={creating}>
          <PlusIcon /> Create & add resume
        </Button>
      </Card>

      {profiles.length > 0 && (
        <div className="mb-3">
          <SearchInput
            value={paged.query}
            onChange={(e) => paged.setQuery(e.target.value)}
            placeholder="Search profiles by name or role…"
          />
        </div>
      )}

      <div className="space-y-2">
        {profiles.length === 0 && (
          <p className="py-8 text-center text-sm text-neutral-500">
            No profiles yet — create one above, or use{' '}
            <button onClick={loadSamples} className="text-indigo-300 underline hover:text-indigo-200">
              Load sample data
            </button>{' '}
            to try the app with a sample résumé + interviews.
          </p>
        )}
        {profiles.length > 0 && paged.total === 0 && (
          <p className="py-8 text-center text-sm text-neutral-500">No profiles match your search.</p>
        )}
        {paged.pageItems.map((p) => (
          <Card key={p.id} className="flex items-center justify-between !py-4">
            <Link to={`/profiles/${p.id}`} className="group flex-1">
              <div className="font-medium group-hover:text-indigo-300">{p.name}</div>
              <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
                <span>{p.targetRole || '—'}</span>
                {p.parsedResume ? (
                  <Badge tone="green">resume ✓</Badge>
                ) : (
                  <Badge tone="amber">no resume</Badge>
                )}
              </div>
            </Link>
            <div className="flex gap-2">
              <Link to={`/profiles/${p.id}`}>
                <Button variant="ghost">Edit</Button>
              </Link>
              <Button variant="ghost" className="text-red-300" onClick={() => remove(p.id)}>
                Delete
              </Button>
            </div>
          </Card>
        ))}
        <Pager page={paged.page} totalPages={paged.totalPages} onPage={paged.setPage} />
      </div>
    </Page>
  );
}
