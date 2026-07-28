import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Badge, Button, Card, Field, Modal, Select } from '../../../components/ui';
import { SectionHeading } from './parts';
import type { Entity, MemoryItem } from '@shared/types';

/**
 * Browse memory by who and what it is about (docs/14-MEMORY.md §3.2) — the
 * question similarity search answers badly. "What do we know about Acme?" is a
 * join, not a topic.
 *
 * Merging lives here because the store never merges on its own. Two spellings
 * of one company stay separate until someone says they are the same, which
 * means this list is where over-splitting becomes visible and gets fixed.
 */
export function EntityBrowser({
  profileId,
  onError,
}: {
  profileId: string;
  onError: (message: string) => void;
}) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [open, setOpen] = useState<{ entity: Entity; memories: MemoryItem[] } | null>(null);
  const [mergeInto, setMergeInto] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setEntities(await api.memory.entities(profileId));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    if (profileId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openEntity = (id: string) =>
    void act(async () => {
      setOpen(await api.memory.entity(profileId, id));
      setMergeInto('');
    });

  const doMerge = () =>
    void act(async () => {
      await api.memory.entityMerge(open!.entity.id, mergeInto);
      setOpen(null);
    });

  if (entities.length === 0) {
    return (
      <>
        <SectionHeading tone="blue">People, companies and projects</SectionHeading>
        <p className="mb-6 text-sm text-neutral-500">
          Nobody yet. Names appear here as memories start mentioning them.
        </p>
      </>
    );
  }

  return (
    <>
      <SectionHeading count={entities.length} tone="blue">
        People, companies and projects
      </SectionHeading>
      <p className="mb-3 text-xs leading-relaxed text-neutral-500">
        BrainCue never guesses that two spellings are the same person — “Acme” and “Acme Corp” stay
        apart until you say otherwise, because folding two different people together is the kind of
        mistake you would never notice. Open one to merge it.
      </p>
      <div className="mb-6 grid gap-2 sm:grid-cols-2">
        {entities.map((e) => (
          <Card key={e.id} className="!py-3">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => openEntity(e.id)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-neutral-200">{e.canonicalName}</span>
                <span className="text-xs text-neutral-500">{e.kind}</span>
              </span>
              <Badge tone={e.memoryCount ? 'blue' : 'neutral'}>{e.memoryCount ?? 0}</Badge>
            </button>
          </Card>
        ))}
      </div>

      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.entity.canonicalName}>
        <div className="mb-4 flex items-center gap-2 text-xs text-neutral-500">
          <Badge>{open?.entity.kind}</Badge>
          <span>{open?.memories.length ?? 0} current memories</span>
        </div>
        <ul className="mb-5 space-y-1">
          {open?.memories.map((m) => (
            <li key={m.id} className="rounded-lg bg-neutral-950/60 px-3 py-2 text-sm text-neutral-300">
              {m.content}
            </li>
          ))}
          {open?.memories.length === 0 && (
            <li className="text-sm text-neutral-500">
              Nothing current — the memories that mentioned this have been replaced or archived.
            </li>
          )}
        </ul>

        <Field
          label="Same as another entry?"
          hint="Memories move across and the old spelling keeps resolving here. Nothing is deleted."
        >
          <Select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
            <option value="">Keep separate</option>
            {entities
              .filter((e) => e.id !== open?.entity.id)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.canonicalName} ({e.kind})
                </option>
              ))}
          </Select>
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(null)}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={!mergeInto} onClick={doMerge}>
            Merge into it
          </Button>
        </div>
      </Modal>
    </>
  );
}
