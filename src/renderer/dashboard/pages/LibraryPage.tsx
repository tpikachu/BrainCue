import { useSearchParams } from 'react-router-dom';
import { FLAGS } from '@shared/flags';
import { Page } from '../../components/ui';
import { SpacesTab } from '../library/SpacesTab';
import { DocumentsTab } from '../library/DocumentsTab';
import { MemoryTab } from '../library/MemoryTab';

type TabId = 'spaces' | 'documents' | 'memory';

/**
 * The Library: everything BrainCue knows about the ACTIVE profile — its Spaces
 * (the v1 jobs, now one kind of context pack), its documents, its memory.
 *
 * There was a Profile tab here too, from when the app had no idea whose
 * dashboard it was: it listed every profile, created them, and deleted them,
 * sitting alongside three tabs that showed exactly one profile's things. So the
 * Library was both "what BrainCue knows about you" and "which you" — one of
 * which is now the sidebar switcher's job (docs/19-ACTIVE-PROFILE.md) and the
 * other of which is the profile editor's. Editing who you are lives at
 * `/profiles/:id`, reached from the switcher.
 *
 * The active tab lives in the URL (?tab=documents) so Home and Spaces rows can
 * deep-link; Memory appears only when it ships (FLAGS.memory) rather than
 * sitting here dead.
 */
export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'spaces', label: 'Spaces' },
    { id: 'documents', label: 'Documents' },
    ...(FLAGS.memory ? [{ id: 'memory' as TabId, label: 'Memory' }] : []),
  ];
  const raw = params.get('tab');
  const tab: TabId = tabs.some((t) => t.id === raw) ? (raw as TabId) : 'spaces';

  return (
    <Page
      title="Library"
      subtitle="What BrainCue knows for this profile — Spaces, documents, and memory."
    >
      <div role="tablist" aria-label="Library sections" className="mb-6 flex gap-1 border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'spaces' ? {} : { tab: t.id })}
            className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${
              tab === t.id
                ? 'border-indigo-400 text-neutral-100'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'spaces' && <SpacesTab />}
      {tab === 'documents' && <DocumentsTab />}
      {tab === 'memory' && <MemoryTab />}
    </Page>
  );
}
