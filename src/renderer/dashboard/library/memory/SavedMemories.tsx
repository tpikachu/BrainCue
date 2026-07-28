import { useState } from 'react';
import { api } from '../../../lib/api';
import { Button, Card, Field, Modal, SearchInput, TextArea, TextInput } from '../../../components/ui';
import { Checkbox, MemoryMeta, SectionHeading } from './parts';
import type { MemoryItem } from '@shared/types';

/**
 * Saved memory, and the three edits that need more than a text field:
 *
 *  • **merge** — several memories saying one thing become the one sentence you
 *    would actually want read back to you. Sources are archived, not deleted.
 *  • **split** — one candidate that bundled three facts becomes three, so each
 *    can be recalled (and later corrected) on its own.
 *  • **history** — what a fact used to say, for anything with a fact key.
 */
export function SavedMemories({
  approved,
  query,
  onQuery,
  spaceTitle,
  profileId,
  onRefresh,
  onError,
}: {
  approved: MemoryItem[];
  query: string;
  onQuery: (q: string) => void;
  spaceTitle: (packId: string | null) => string;
  profileId: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState<string | null>(null); // draft merged text
  const [splitting, setSplitting] = useState<{ m: MemoryItem; draft: string } | null>(null);
  const [history, setHistory] = useState<{ factKey: string; rows: MemoryItem[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
      await onRefresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = approved.filter((m) => selected.has(m.id));

  const openMerge = () =>
    setMerging(chosen.map((m) => m.content.replace(/\s*$/, '')).join(' '));

  const doMerge = () =>
    void act(async () => {
      await api.memory.merge({ ids: chosen.map((m) => m.id), content: merging ?? '' });
      setMerging(null);
      setSelected(new Set());
    });

  const doSplit = () =>
    void act(async () => {
      const parts = (splitting?.draft ?? '')
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);
      await api.memory.split(splitting!.m.id, parts);
      setSplitting(null);
    });

  const openHistory = (factKey: string) =>
    void act(async () => setHistory({ factKey, rows: await api.memory.history(profileId, factKey) }));

  return (
    <>
      <SectionHeading count={approved.length} tone="blue">
        Saved memories
      </SectionHeading>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1">
          <SearchInput
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search saved memories…"
          />
        </div>
        {selected.size >= 2 && (
          <Button variant="primary" onClick={openMerge}>
            Merge {selected.size}
          </Button>
        )}
      </div>

      {approved.length === 0 ? (
        <p className="mb-6 text-sm text-neutral-500">
          No saved memories{query ? ' match your search' : ' yet'}.
        </p>
      ) : (
        <div className="mb-6 space-y-2">
          {approved.map((m) => (
            <Card key={m.id} className="!py-3">
              <div className="flex gap-3">
                <Checkbox
                  checked={selected.has(m.id)}
                  onChange={(v) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (v) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    })
                  }
                  label={`Select "${m.content.slice(0, 40)}"`}
                />
                <div className="min-w-0 flex-1">
                  <MemoryMeta m={m} spaceTitle={spaceTitle} />
                  <TextInput
                    value={edits[m.id] ?? m.content}
                    aria-label="Memory text"
                    onChange={(e) => setEdits((d) => ({ ...d, [m.id]: e.target.value }))}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {edits[m.id] !== undefined && edits[m.id] !== m.content && (
                      <Button
                        variant="primary"
                        loading={busy}
                        onClick={() => void act(() => api.memory.update(m.id, { content: edits[m.id] }))}
                      >
                        Save
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => setSplitting({ m, draft: m.content })}
                      title="Break this into separate facts"
                    >
                      Split
                    </Button>
                    {m.factKey && (
                      <Button variant="ghost" onClick={() => openHistory(m.factKey!)}>
                        History
                      </Button>
                    )}
                    <Button variant="ghost" loading={busy} onClick={() => void act(() => api.memory.archive(m.id))}>
                      Archive
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-red-300"
                      loading={busy}
                      title="Delete this memory and its embedding permanently"
                      onClick={() => void act(() => api.memory.delete(m.id))}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={merging !== null} onClose={() => setMerging(null)} title="Merge memories">
        <p className="mb-3 text-xs leading-relaxed text-neutral-500">
          The {chosen.length} memories below are replaced by the single sentence you write here.
          They are archived rather than deleted, so you can still read them afterwards.
        </p>
        <ul className="mb-4 space-y-1">
          {chosen.map((m) => (
            <li key={m.id} className="rounded-lg bg-neutral-950/60 px-3 py-2 text-sm text-neutral-400">
              {m.content}
            </li>
          ))}
        </ul>
        <Field label="Keep this instead">
          <TextArea rows={3} value={merging ?? ''} onChange={(e) => setMerging(e.target.value)} />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setMerging(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={(merging ?? '').trim().length < 3}
            onClick={doMerge}
          >
            Merge
          </Button>
        </div>
      </Modal>

      <Modal open={!!splitting} onClose={() => setSplitting(null)} title="Split into separate facts">
        <p className="mb-3 text-xs leading-relaxed text-neutral-500">
          One line per memory. The original is archived. Splitting clears the fact key, because a
          fact broken into several statements no longer has a single current value — re-add the key
          to whichever line still owns it.
        </p>
        <Field label="One memory per line">
          <TextArea
            rows={5}
            value={splitting?.draft ?? ''}
            onChange={(e) => setSplitting((s) => (s ? { ...s, draft: e.target.value } : s))}
          />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setSplitting(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={(splitting?.draft ?? '').split('\n').filter((p) => p.trim()).length < 2}
            onClick={doSplit}
          >
            Split
          </Button>
        </div>
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title="What this fact used to say">
        <p className="mb-3 font-mono text-xs text-neutral-500">{history?.factKey}</p>
        <ol className="space-y-2">
          {history?.rows.map((r) => (
            <li
              key={r.id}
              className={`rounded-lg border p-3 ${
                r.supersededBy
                  ? 'border-white/5 bg-neutral-950/60 text-neutral-500'
                  : 'border-emerald-500/20 bg-emerald-500/5 text-neutral-200'
              }`}
            >
              <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider">
                <span>v{r.revision}</span>
                <span>{r.supersededBy ? 'replaced' : 'current'}</span>
                <span className="text-neutral-600">
                  {new Date(r.validFrom).toLocaleDateString()}
                  {r.validTo ? ` – ${new Date(r.validTo).toLocaleDateString()}` : ''}
                </span>
              </div>
              <p className="text-sm">{r.content}</p>
            </li>
          ))}
        </ol>
      </Modal>
    </>
  );
}
