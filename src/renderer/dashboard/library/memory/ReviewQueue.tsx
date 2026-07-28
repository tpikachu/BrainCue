import { useState } from 'react';
import { api } from '../../../lib/api';
import { Badge, Button, Card, TextInput } from '../../../components/ui';
import { Checkbox, MemoryMeta, SectionHeading } from './parts';
import type { MemoryConflict, MemoryItem } from '@shared/types';

/**
 * The review queue, in two halves.
 *
 * Conflicts come FIRST and are never part of the bulk selection. Approving a
 * conflicting candidate retires the fact it replaces (docs/14-MEMORY.md §3.1) —
 * that is a decision about what is true now, and it should not be something a
 * user does by ticking "select all" without reading. Everything else can be
 * swept through in one action.
 */
export function ReviewQueue({
  pending,
  conflicts,
  spaceTitle,
  onRefresh,
  onError,
}: {
  pending: MemoryItem[];
  conflicts: MemoryConflict[];
  spaceTitle: (packId: string | null) => string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const conflictIds = new Set(conflicts.map((c) => c.candidate.id));
  const plain = pending.filter((m) => !conflictIds.has(m.id));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
      setSelected(new Set());
      await onRefresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const bulk = (action: 'approve' | 'reject') =>
    act(async () => {
      const res = await api.memory.reviewMany([...selected], action);
      // A partial result is reported, not hidden — the queue would otherwise
      // just look like it silently ignored some of the selection.
      if (res.failed.length) {
        onError(
          `${res.failed.length} of ${selected.size} could not be ${action}d: ${res.failed[0].error}`,
        );
      }
    });

  return (
    <>
      {conflicts.length > 0 && (
        <>
          <SectionHeading count={conflicts.length} tone="red">
            Contradicts what you already told it
          </SectionHeading>
          <div className="mb-6 space-y-2">
            {conflicts.map(({ candidate, current }) => (
              <Card key={candidate.id} className="!py-3 ring-1 ring-red-500/20">
                <MemoryMeta m={candidate} spaceTitle={spaceTitle} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-white/5 bg-neutral-950/60 p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
                      Now
                    </div>
                    <p className="text-sm text-neutral-400">{current.content}</p>
                  </div>
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-amber-400/80">
                      Proposed
                    </div>
                    <TextInput
                      value={edits[candidate.id] ?? candidate.content}
                      aria-label="Replacement text"
                      onChange={(e) =>
                        setEdits((d) => ({ ...d, [candidate.id]: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="success"
                    loading={busy}
                    onClick={() =>
                      void act(() =>
                        api.memory.review(candidate.id, 'approve', {
                          content: edits[candidate.id] ?? candidate.content,
                        }),
                      )
                    }
                  >
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    loading={busy}
                    onClick={() => void act(() => api.memory.review(candidate.id, 'reject'))}
                  >
                    Keep the old one
                  </Button>
                  <span className="text-xs text-neutral-600">
                    Replacing keeps the old wording in this fact’s history.
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <SectionHeading count={plain.length}>To review</SectionHeading>
      {plain.length === 0 ? (
        <p className="mb-6 text-sm text-neutral-500">
          Nothing waiting. Candidates appear here after sessions, or when you import a document.
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() =>
                setSelected((s) =>
                  s.size === plain.length ? new Set() : new Set(plain.map((m) => m.id)),
                )
              }
            >
              {selected.size === plain.length ? 'Clear selection' : `Select all ${plain.length}`}
            </Button>
            {selected.size > 0 && (
              <>
                <Button variant="success" loading={busy} onClick={() => void bulk('approve')}>
                  Approve {selected.size}
                </Button>
                <Button variant="ghost" loading={busy} onClick={() => void bulk('reject')}>
                  Reject {selected.size}
                </Button>
              </>
            )}
          </div>
          <div className="mb-6 space-y-2">
            {plain.map((m) => (
              <Card key={m.id} className="!py-3">
                <div className="flex gap-3">
                  <Checkbox
                    checked={selected.has(m.id)}
                    onChange={(v) => toggle(m.id, v)}
                    label={`Select "${m.content.slice(0, 40)}"`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      <MemoryMeta m={m} spaceTitle={spaceTitle} />
                      <Badge>{(m.confidence * 100).toFixed(0)}% sure</Badge>
                    </div>
                    <TextInput
                      value={edits[m.id] ?? m.content}
                      aria-label="Memory candidate text"
                      onChange={(e) => setEdits((d) => ({ ...d, [m.id]: e.target.value }))}
                    />
                    <div className="mt-2 flex gap-2">
                      <Button
                        variant="success"
                        loading={busy}
                        onClick={() =>
                          void act(() =>
                            api.memory.review(m.id, 'approve', { content: edits[m.id] ?? m.content }),
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        loading={busy}
                        onClick={() => void act(() => api.memory.review(m.id, 'reject'))}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
