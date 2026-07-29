import { useSearchParams } from 'react-router-dom';
import { Page } from '../../components/ui';
import { SpacesTab } from '../library/SpacesTab';
import { DocumentsTab } from '../library/DocumentsTab';

type TabId = 'spaces' | 'documents';

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
 * Memory left too, for a different reason: the Library is the knowledge base
 * you assemble deliberately, while Memory is what BrainCue proposes to keep
 * from your conversations and has a queue waiting on you. It has its own
 * section now (docs/16-CONTINUITY.md §12).
 *
 * The active tab lives in the URL (?tab=documents) so Home and Spaces rows can
 * deep-link.
 */
export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'spaces', label: 'Spaces' },
    { id: 'documents', label: 'Documents' },
  ];
  const raw = params.get('tab');
  const tab: TabId = tabs.some((t) => t.id === raw) ? (raw as TabId) : 'spaces';

  return (
    <Page
      title="Library"
      subtitle="What BrainCue knows for this profile: the Spaces that ground it, and the documents behind them."
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

      <div data-tour="library-content">
        {tab === 'spaces' && <SpacesTab />}
        {tab === 'documents' && <DocumentsTab />}
      </div>
    </Page>
  );
}
