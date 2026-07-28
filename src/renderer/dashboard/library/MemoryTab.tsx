import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { Job, MemoryConflict, MemoryItem } from '@shared/types';
import { Button, Card, Field, Select, Switch } from '../../components/ui';
import { AddMemory } from './memory/AddMemory';
import { EntityBrowser } from './memory/EntityBrowser';
import { ReviewQueue } from './memory/ReviewQueue';
import { SavedMemories } from './memory/SavedMemories';

/** Library › Memory: the review-first memory manager (docs/14-MEMORY.md).
 *  Nothing is captured before the consent switch is on, nothing is recalled
 *  until it is explicitly approved here, every item shows where it came from,
 *  and delete removes the memory together with its embedding. */

type Tab = 'review' | 'saved' | 'people';

export function MemoryTab() {
  const { profiles, load } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const [profileId, setProfileId] = useState('');
  const [tab, setTab] = useState<Tab>('review');
  const [pending, setPending] = useState<MemoryItem[]>([]);
  const [approved, setApproved] = useState<MemoryItem[]>([]);
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [query, setQuery] = useState('');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setConflicts(await api.memory.conflicts(pid));
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
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const spaceTitle = (packId: string | null) => {
    if (!packId) return 'Global';
    const s = spaces.find((x) => x.id === packId);
    return s ? s.company || s.title || 'Space' : 'Space';
  };

  const exportMemory = () =>
    void act(async () => {
      const r = await api.memory.export(profileId);
      setNote(r.saved ? `Saved ${r.count} memories to ${r.filePath}` : null);
    });

  const importMemory = () =>
    void act(async () => {
      const r = await api.memory.import(profileId, 'review');
      if (r.cancelled) return;
      const parts = [`${r.imported ?? 0} imported`];
      if (r.duplicates) parts.push(`${r.duplicates} already known`);
      if (r.blocked) parts.push(`${r.blocked} blocked as sensitive`);
      if (r.unmatchedScopes?.length) {
        parts.push(`${r.unmatchedScopes.length} Spaces not found here — imported as global`);
      }
      setNote(`${parts.join(' · ')}.`);
    });

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'review', label: 'Review', badge: pending.length },
    { id: 'saved', label: 'Saved', badge: approved.length },
    { id: 'people', label: 'People & companies' },
  ];

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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[16rem] flex-1">
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
          </div>
          {/* Portability sits next to the profile it belongs to. The file is
              plain JSON so it can be read and edited; where it goes after that
              is the user's decision, and nothing is uploaded. */}
          <div className="flex items-center gap-2">
            <Button variant="default" loading={busy} disabled={!profileId} onClick={exportMemory}>
              Export…
            </Button>
            <Button variant="default" loading={busy} disabled={!profileId} onClick={importMemory}>
              Import…
            </Button>
          </div>
        </div>
      </Card>

      {error && (
        <p
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
          role="alert"
        >
          ⚠ {error}
        </p>
      )}
      {note && (
        <p className="mb-4 rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-300">
          {note}
        </p>
      )}

      {profileId && (
        <>
          <AddMemory profileId={profileId} onDone={() => refresh()} onError={setError} />

          <div className="mb-4 flex items-center gap-2 border-b border-white/5 pb-2">
            {tabs.map((t) => (
              <Button
                key={t.id}
                variant={tab === t.id ? 'primary' : 'ghost'}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {!!t.badge && <span className="text-xs opacity-70">{t.badge}</span>}
              </Button>
            ))}
          </div>

          {tab === 'review' && (
            <ReviewQueue
              pending={pending}
              conflicts={conflicts}
              spaceTitle={spaceTitle}
              onRefresh={() => refresh()}
              onError={setError}
            />
          )}
          {tab === 'saved' && (
            <SavedMemories
              approved={approved}
              query={query}
              onQuery={setQuery}
              spaceTitle={spaceTitle}
              profileId={profileId}
              onRefresh={() => refresh()}
              onError={setError}
            />
          )}
          {tab === 'people' && <EntityBrowser profileId={profileId} onError={setError} />}

          {/* Per-Space opt-out */}
          {spaces.length > 0 && (
            <>
              <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-wider text-neutral-500">
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
