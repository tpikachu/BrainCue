import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useActiveProfile } from '../../store/useProfileStore';
import type { Job, Story } from '@shared/types';
import { Badge, Card } from '../../components/ui';
import { FLAGS } from '@shared/flags';

/** Library › Documents: everything BrainCue has ingested for a profile —
 *  the résumé, STAR stories, and each Space's JD / company research. Read-only
 *  inventory with pointers to where each document is edited; the editing
 *  surfaces themselves stay where they are (Profile editor, Space detail). */
export function DocumentsTab() {
  // Whose documents these are is decided once, in the sidebar switcher.
  const profile = useActiveProfile();
  const profileId = profile?.id ?? '';
  const [stories, setStories] = useState<Story[]>([]);
  const [spaces, setSpaces] = useState<Job[]>([]);

  useEffect(() => {
    if (!profileId) {
      setStories([]);
      setSpaces([]);
      return;
    }
    if (FLAGS.storyBank) {
      void api.stories.list(profileId).then(setStories).catch(() => setStories([]));
    }
    void api.jobs
      .page(profileId, '', 100, 0)
      .then(({ items }) => setSpaces(items as Job[]))
      .catch(() => setSpaces([]));
  }, [profileId]);

  return (
    <div>
      <p className="mb-4 text-sm text-neutral-400">
        Everything BrainCue has ingested for this profile. Documents are parsed and indexed locally;
        only retrieved snippets are ever sent per question.
      </p>

      {profile && (
        <div className="space-y-3">
          <Card className="flex items-center justify-between !py-4">
            <div>
              <div className="font-medium text-neutral-100">Résumé</div>
              <div className="mt-1 text-xs text-neutral-500">
                Grounds every answer in your real experience.
              </div>
            </div>
            <div className="flex items-center gap-3">
              {profile.parsedResume ? (
                <Badge tone="green">parsed ✓</Badge>
              ) : (
                <Badge tone="amber">missing</Badge>
              )}
              <Link to={`/profiles/${profile.id}`} className="text-sm text-indigo-300 hover:text-indigo-200">
                Edit in profile →
              </Link>
            </div>
          </Card>

          {/* Inventory entry for the story bank. Conditional render, not a
              `hidden` class — the hidden version still cost an IPC round-trip
              to fill a badge nobody could see. */}
          {FLAGS.storyBank && (
          <Card className="flex items-center justify-between !py-4">
            <div>
              <div className="font-medium text-neutral-100">STAR stories</div>
              <div className="mt-1 text-xs text-neutral-500">
                Extracted from the résumé; surfaced live as “Story to tell” cues.
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={stories.length > 0 ? 'green' : 'neutral'}>
                {stories.length > 0 ? `${stories.length} stories` : 'none yet'}
              </Badge>
              <Link to={`/profiles/${profile.id}`} className="text-sm text-indigo-300 hover:text-indigo-200">
                Manage →
              </Link>
            </div>
          </Card>
          )}

          <Card>
            <div className="mb-3 font-medium text-neutral-100">Per-Space documents</div>
            {spaces.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No Spaces yet — create one in the Spaces tab to attach a JD or company research.
              </p>
            ) : (
              <ul className="space-y-2">
                {spaces.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between rounded-lg bg-neutral-950/50 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-neutral-300">
                      {s.title || 'Untitled'}
                      {s.company ? ` · ${s.company}` : ''}
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      {s.parsedJd ? <Badge tone="green">JD ✓</Badge> : <Badge tone="amber">no JD</Badge>}
                      {s.parsedCompany && <Badge tone="blue">company ✓</Badge>}
                      {/* A tailored résumé is a document OF the Space, so it is
                          listed with the Space's other documents rather than
                          hidden inside the editor that produced it. */}
                      {s.tailoredResume && <Badge tone="blue">tailored résumé ✓</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
