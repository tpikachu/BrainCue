import { useState } from 'react';
import { api } from '../../../lib/api';
import { Button, Card, Field, Select, TextArea } from '../../../components/ui';
import { CATEGORIES } from './parts';
import type { MemoryCategory } from '@shared/types';

/**
 * The two authoring paths (docs/14-MEMORY.md §3.5): type one memory, or hand
 * over a whole document as "things to know about me".
 *
 * Both land in the review queue rather than straight in memory. That is the
 * point of the gate — a document is a much bigger claim than a sentence, and
 * approving 40 facts you have not read would be the fastest way to fill your
 * memory with things you do not actually believe.
 */
export function AddMemory({
  profileId,
  onDone,
  onError,
}: {
  profileId: string;
  onDone: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<'one' | 'document'>('one');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('fact');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    onError('');
    try {
      setNote(await fn());
      await onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addOne = () =>
    run(async () => {
      await api.memory.create({ profileId, packId: null, category, content: content.trim() });
      setContent('');
      return 'Added to the review queue below.';
    });

  const ingest = (args: { text?: string; filePath?: string }) =>
    run(async () => {
      const r = await api.memory.ingest({ profileId, packId: null, ...args });
      setPaste('');
      // Say what actually happened, including what was skipped — "12 proposed"
      // alone would hide a document that was half-unreadable or truncated.
      const parts = [`${r.proposed} to review`];
      if (r.duplicates) parts.push(`${r.duplicates} already known`);
      if (r.blocked) parts.push(`${r.blocked} blocked as sensitive`);
      if (r.belowFloor) parts.push(`${r.belowFloor} too vague`);
      if (r.chunksFailed) parts.push(`${r.chunksFailed} of ${r.chunks} sections could not be read`);
      if (r.truncated) parts.push(`only the first ${r.chunks} sections were read`);
      return `${parts.join(' · ')}.`;
    });

  const pickFile = async () => {
    const { filePath } = await api.dialog.openFile();
    if (filePath) await ingest({ filePath });
  };

  return (
    <Card className="mb-6">
      <div className="mb-4 flex items-center gap-2">
        {(['one', 'document'] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? 'primary' : 'ghost'}
            onClick={() => {
              setMode(m);
              setNote(null);
            }}
          >
            {m === 'one' ? 'Add a memory' : 'Import a document'}
          </Button>
        ))}
      </div>

      {mode === 'one' ? (
        <div className="space-y-3">
          <Field label="What should BrainCue remember?" hint="One self-contained sentence.">
            <TextArea
              rows={2}
              value={content}
              placeholder="I report to Sarah Chen, who runs the Atlas programme."
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          <div className="flex items-end gap-3">
            <div className="w-48">
              <Field label="Category">
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as MemoryCategory)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              variant="primary"
              loading={busy}
              disabled={content.trim().length < 3}
              onClick={() => void addOne()}
            >
              Add
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-neutral-500">
            A bio, a brag document, an account brief, meeting notes — anything you would hand a
            colleague standing in for you. It is read on this machine and turned into separate
            memories you review below. Nothing is remembered until you approve it.
          </p>
          <Field label="Paste the text">
            <TextArea
              rows={5}
              value={paste}
              placeholder="Paste “things to know about me” here…"
              onChange={(e) => setPaste(e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              loading={busy}
              disabled={paste.trim().length < 40}
              onClick={() => void ingest({ text: paste })}
            >
              Read this text
            </Button>
            <Button variant="default" loading={busy} onClick={() => void pickFile()}>
              Choose a file…
            </Button>
            <span className="text-xs text-neutral-600">pdf · docx · txt · md</span>
          </div>
        </div>
      )}

      {note && <p className="mt-3 text-sm text-emerald-300">{note}</p>}
    </Card>
  );
}
