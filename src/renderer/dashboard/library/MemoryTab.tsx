import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { Job, MemoryItem } from '@shared/types';
import { Badge, Button, Card, Field, SearchInput, Select, Switch, TextInput } from '../../components/ui';

/** Library › Memory: the review-first memory surface. Nothing is captured
 *  before the consent switch is on; nothing is recalled until a candidate is
 *  explicitly approved here. Every item shows its provenance and scope, and
 *  delete removes the memory together with its embedding. */
export function MemoryTab() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const [profileId, setProfileId] = useState('');
  const [pending, setPending] = useState<MemoryItem[]>([]);
  const [approved, setApproved] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({}); // id → draft content
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);
  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  const refresh = async (pid = profileId) => {
    if (!pid) return;
    setPending(await api.memory.list(pid, { status: 'pending' }));
    setApproved(await api.memory.list(pid, { status: 'approved', query: query.trim() || undefined }));
    const { items } = await api.jobs.page(pid, '', 100, 0);
    setSpaces(items as Job[]);
  };

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, query]);

  const memoryOn = !!settings?.memoryEnabled;
  const setConsent = async (on: boolean) => {
    await api.settings.set({ memoryEnabled: on });
    await loadSettings();
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const spaceTitle = (packId: string | null) => {
    if (!packId) return 'Global';
    const s = spaces.find((x) => x.id === packId);
    return s ? s.company || s.title || 'Space' : 'Space';
  };

  return (
    <div>
      <Card className="mb-5 flex items-center justify-between !py-4">
        <div>
          <div className="font-medium text-neutral-100">Memory</div>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral-500">
            When on, BrainCue suggests memories after each session — nothing is saved until you
            approve it here, only approved memories ever ground answers, and everything stays in
            the local database. Secrets, payment, health, and similar content are never stored.
          </p>
        </div>
        <Switch checked={memoryOn} onChange={(v) => void setConsent(v)} />
      </Card>

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

      {error && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300" role="alert">
          ⚠ {error}
        </p>
      )}

      {/* Review queue */}
      {profileId && (
        <>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
            To review {pending.length > 0 && <Badge tone="amber">{pending.length}</Badge>}
          </h3>
          {pending.length === 0 ? (
            <p className="mb-6 text-sm text-neutral-500">
              Nothing waiting. {memoryOn ? 'Candidates appear here after sessions.' : 'Turn memory on to start collecting suggestions.'}
            </p>
          ) : (
            <div className="mb-6 space-y-2">
              {pending.map((m) => (
                <Card key={m.id} className="!py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                    <Badge>{m.category}</Badge>
                    <Badge tone="blue">{spaceTitle(m.packId)}</Badge>
                    <span>confidence {(m.confidence * 100).toFixed(0)}%</span>
                    {m.sourceRefs?.map((r) => (
                      <span key={r.id} className="text-neutral-600">
                        from {r.type}
                      </span>
                    ))}
                  </div>
                  <TextInput
                    value={edits[m.id] ?? m.content}
                    aria-label="Memory candidate text"
                    onChange={(e) => setEdits((d) => ({ ...d, [m.id]: e.target.value }))}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="success"
                      onClick={() =>
                        void act(() =>
                          api.memory.review(m.id, 'approve', {
                            content: edits[m.id] ?? m.content,
                          }),
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button variant="ghost" onClick={() => void act(() => api.memory.review(m.id, 'reject'))}>
                      Reject
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Approved memory */}
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Saved memories
          </h3>
          <div className="mb-3">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search saved memories…"
            />
          </div>
          {approved.length === 0 ? (
            <p className="mb-6 text-sm text-neutral-500">No saved memories{query ? ' match your search' : ' yet'}.</p>
          ) : (
            <div className="mb-6 space-y-2">
              {approved.map((m) => (
                <Card key={m.id} className="!py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                    <Badge>{m.category}</Badge>
                    <Badge tone="blue">{spaceTitle(m.packId)}</Badge>
                    {m.lastUsedAt && (
                      <span>last used {new Date(m.lastUsedAt).toLocaleDateString()}</span>
                    )}
                    {m.sourceRefs?.map((r) => (
                      <span key={r.id} className="text-neutral-600">
                        from {r.type}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <TextInput
                      value={edits[m.id] ?? m.content}
                      aria-label="Memory text"
                      onChange={(e) => setEdits((d) => ({ ...d, [m.id]: e.target.value }))}
                    />
                    {edits[m.id] !== undefined && edits[m.id] !== m.content && (
                      <Button
                        variant="primary"
                        onClick={() => void act(() => api.memory.update(m.id, { content: edits[m.id] }))}
                      >
                        Save
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => void act(() => api.memory.archive(m.id))}>
                      Archive
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-red-300"
                      title="Delete this memory and its embedding permanently"
                      onClick={() => void act(() => api.memory.delete(m.id))}
                    >
                      Delete
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Per-Space opt-out */}
          {spaces.length > 0 && (
            <>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Per-Space memory
              </h3>
              <Card>
                <ul className="space-y-2">
                  {spaces.map((s) => (
                    <li key={s.id} className="flex items-center justify-between">
                      <span className="min-w-0 truncate text-sm text-neutral-300">
                        {s.title || 'Untitled'}
                        {s.company ? ` · ${s.company}` : ''}
                      </span>
                      <Switch
                        checked={s.memoryEnabled}
                        onChange={(v) => void act(() => api.memory.setPackEnabled(s.id, v))}
                       
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
