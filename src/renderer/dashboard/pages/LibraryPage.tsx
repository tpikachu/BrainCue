import { useSearchParams } from 'react-router-dom';
import { FLAGS } from '@shared/flags';
import { Page } from '../../components/ui';
import { ProfilesTab } from '../library/ProfilesTab';
import { SpacesTab } from '../library/SpacesTab';
import { DocumentsTab } from '../library/DocumentsTab';
import { MemoryTab } from '../library/MemoryTab';

type TabId = 'profile' | 'spaces' | 'documents' | 'memory';

/** The Library: everything BrainCue knows — your Profile, your Spaces (the v1
 *  jobs, now one kind of context pack), and the Documents inventory. Memory
 *  joins as a tab when it ships (FLAGS.memory) rather than sitting here dead.
 *  The active tab lives in the URL (?tab=spaces) so Home and Spaces rows can
 *  deep-link. */
export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'spaces', label: 'Spaces' },
    { id: 'documents', label: 'Documents' },
    ...(FLAGS.memory ? [{ id: 'memory' as TabId, label: 'Memory' }] : []),
  ];
  const raw = params.get('tab');
  const tab: TabId = tabs.some((t) => t.id === raw) ? (raw as TabId) : 'profile';

  return (
    <Page title="Library" subtitle="Who you are and what BrainCue should know — profiles, Spaces, and documents.">
      <div role="tablist" aria-label="Library sections" className="mb-6 flex gap-1 border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'profile' ? {} : { tab: t.id })}
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

      {tab === 'profile' && <ProfilesTab />}
      {tab === 'spaces' && <SpacesTab />}
      {tab === 'documents' && <DocumentsTab />}
      {tab === 'memory' && <MemoryTab />}
    </Page>
  );
}
