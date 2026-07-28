import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { Job, MemoryItem } from '@shared/types';
import { Badge, Button, Card, Field, Page, SearchInput, Select, Switch, TextInput } from '../../components/ui';

/**
 * Memory — the review-first surface for what BrainCue remembers about this
 * profile.
 *
 * Its own section rather than a Library tab. The Library is the knowledge base
 * you assemble: documents you chose to give it, Spaces you set up. Memory is
 * what it proposes to keep from your conversations, and every item there is
 * waiting on a decision you have not made yet. Filing that behind a tab in the
 * place you go to add documents buried the one surface that has a queue.
 *
 * Nothing is captured before the consent switch is on; nothing is recalled
 * until a candidate is explicitly approved here. Every item shows its
 * provenance and its scope, and delete removes the memory together with its
 * embedding.
 */
export default function MemoryPage() {
  // Whose memory this is is decided once, in the sidebar switcher.
  const profileId = useProfileStore((s) => s.activeId) ?? '';
  const { settings, load: loadSettings } = useSettingsStore();
  const [pending, setPending] = useState<MemoryItem[]>([]);
  const [approved, setApproved] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState('');
  // '' = every scope, 'global' = remembered everywhere, otherwise a Space id.
  // A Space's memory is a different body of knowledge from another's, and the
  // format that produced it differs by activity — so the table is filterable
  // by the thing that scopes it, not only searchable by text.
  const [scope, setScope] = useState<string>('');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({}); // id → draft content
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const refresh = async (pid = profileId) => {
    if (!pid) return;
    // undefined = every scope; null = the ones recalled everywhere.
    const packId = scope === '' ? undefined : scope === 'global' ? null : scope;
    setPending(await api.memory.list(pid, { status: 'pending', packId }));
    setApproved(
      await api.memory.list(pid, {
        status: 'approved',
        query: query.trim() || undefined,
        packId,
      }),
    );
    const { items } = await api.jobs.page(pid, '', 100, 0);
    setSpaces(items as Job[]);
  };

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, query, scope]);

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
    if (!packId) return 'Everywhere';
    const s = spaces.find((x) => x.id === packId);
    return s ? s.company || s.title || 'Space' : 'Space';
  };

  /**
   * Saved memory, grouped by the Space it belongs to.
   *
   * A flat list said nothing about scope, and scope is the whole point: a
   * memory on a Space is recalled in that Space's conversations and nowhere
   * else, while one on the profile follows the person everywhere. Reading them
   * interleaved, you cannot tell which of your Spaces actually knows something
   * — the question this page exists to answer.
   *
   * Space-scoped groups come first and profile-wide last, because "everywhere"
   * is the fallback rather than a place.
   */
  const grouped = (() => {
    const byPack = new Map<string, MemoryItem[]>();
    for (const m of approved) {
      const key = m.packId ?? '';
      byPack.set(key, [...(byPack.get(key) ?? []), m]);
    }
    const scoped = [...byPack.entries()]
      .filter(([key]) => key !== '')
      .sort((a, b) => spaceTitle(a[0]).localeCompare(spaceTitle(b[0])));
    const global = byPack.get('');
    return [...scoped, ...(global ? ([['', global]] as [string, MemoryItem[]][]) : [])];
  })();

  return (
    <Page
      title="Memory"
      subtitle="What BrainCue remembers about this profile — proposed after each session, kept only when you say so."
      width="max-w-4xl"
    >
      <Card className="mb-5 flex items-center justify-between !py-4">
        <div>
          <div className="font-medium text-neutral-100">Remember across sessions</div>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral-500">
            When on, BrainCue suggests memories after each session — nothing is saved until you
            approve it here, only approved memories ever ground answers, and everything stays in
            the local database. Secrets, payment, health, and similar content are never stored.
          </p>
        </div>
        <Switch checked={memoryOn} onChange={(v) => void setConsent(v)} />
      </Card>

      {/* Filter by what scopes it. A Space's memory is a separate body of
          knowledge from another's — recalled in that Space and nowhere else. */}
      <Card className="mb-5">
        <Field label="Space">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All memory for this profile</option>
            <option value="global">Everywhere — not tied to a Space</option>
            {spaces.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.title || 'Untitled'}
                {sp.company ? ` · ${sp.company}` : ''}
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
            <p className="mb-6 text-sm text-neutral-500">
              No saved memories{query ? ' match your search' : ' yet'}.
            </p>
          ) : (
            <div className="mb-6 space-y-5">
              {grouped.map(([packKey, items]) => (
                <div key={packKey || 'global'}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <Badge tone={packKey ? 'blue' : 'neutral'}>{spaceTitle(packKey || null)}</Badge>
                    <span className="text-xs text-neutral-500">
                      {packKey
                        ? `recalled in this Space · ${items.length}`
                        : `recalled everywhere · ${items.length}`}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {items.map((m) => (
                      <Card key={m.id} className="!py-3">
                        <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                          <Badge>{m.category}</Badge>
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
                              onClick={() =>
                                void act(() => api.memory.update(m.id, { content: edits[m.id] }))
                              }
                            >
                              Save
                            </Button>
                          )}
                          {/* Scope is editable here because where a memory is
                              recalled is a judgement the user often only makes
                              once they see it written down. */}
                          <Select
                            className="w-44 shrink-0"
                            aria-label="Where this memory is recalled"
                            value={m.packId ?? ''}
                            onChange={(e) =>
                              void act(() =>
                                api.memory.update(m.id, { packId: e.target.value || null }),
                              )
                            }
                          >
                            <option value="">Everywhere</option>
                            {spaces.map((sp) => (
                              <option key={sp.id} value={sp.id}>
                                {sp.title || 'Untitled'}
                                {sp.company ? ` · ${sp.company}` : ''}
                              </option>
                            ))}
                          </Select>
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
                </div>
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
    </Page>
  );
}
