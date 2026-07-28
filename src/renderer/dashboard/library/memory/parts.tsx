import type { MemoryItem } from '@shared/types';
import { Badge } from '../../../components/ui';

/** Shared bits of the Memory manager. Kept here so the review queue, the saved
 *  list, and the entity detail view describe a memory the same way — provenance
 *  and scope are the things a user needs to judge one, and they should not
 *  drift between surfaces. */

export const CATEGORIES = [
  'preference',
  'person',
  'project',
  'goal',
  'decision',
  'fact',
  'workflow',
  'custom',
] as const;

/** Where a memory came from, in the user's words rather than the schema's. */
export function provenance(m: MemoryItem): string {
  const ref = m.sourceRefs?.[0];
  if (m.sourceKind === 'authored') return 'you wrote this';
  if (m.sourceKind === 'derived') return 'merged or split';
  if (ref?.type === 'document') return `from ${ref.id}`;
  if (m.sourceKind === 'imported') return 'imported';
  return 'from a session';
}

export function MemoryMeta({
  m,
  spaceTitle,
}: {
  m: MemoryItem;
  spaceTitle: (packId: string | null) => string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
      <Badge>{m.category}</Badge>
      <Badge tone="blue">{spaceTitle(m.packId)}</Badge>
      {m.factKey && (
        <span className="font-mono text-[11px] text-neutral-600" title="Single-valued fact key">
          {m.factKey}
          {m.revision > 1 && ` · v${m.revision}`}
        </span>
      )}
      <span className="text-neutral-600">{provenance(m)}</span>
      {m.lastUsedAt && <span>last used {new Date(m.lastUsedAt).toLocaleDateString()}</span>}
    </div>
  );
}

export function SectionHeading({
  children,
  count,
  tone = 'amber',
}: {
  children: React.ReactNode;
  count?: number;
  tone?: 'amber' | 'blue' | 'red';
}) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
      {children}
      {!!count && <Badge tone={tone}>{count}</Badge>}
    </h3>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-neutral-600 bg-neutral-950 accent-indigo-500"
    />
  );
}
