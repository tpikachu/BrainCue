import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useProfileStore } from '../../store/useProfileStore';
import type { Job, Story } from '@shared/types';
import { Badge, Card, Field, Select } from '../../components/ui';
import { FLAGS } from '@shared/flags';

/** Library › Documents: everything BrainCue has ingested for a profile —
 *  the résumé, STAR stories, and each Space's JD / company research. Read-only
 *  inventory with pointers to where each document is edited; the editing
 *  surfaces themselves stay where they are (Profile editor, Space detail). */
export function DocumentsTab() {
  const { profiles, load } = useProfileStore();
  const [profileId, setProfileId] = useState('');
  const [stories, setStories] = useState<Story[]>([]);
  const [spaces, setSpaces] = useState<Job[]>([]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  useEffect(() => {
    if (!profileId) {
      setStories([]);
      setSpaces([]);
      return;
    }
    void api.stories.list(profileId).then(setStories).catch(() => setStories([]));
    void api.jobs
      .page(profileId, '', 100, 0)
      .then(({ items }) => setSpaces(items as Job[]))
      .catch(() => setSpaces([]));
  }, [profileId]);

  const profile = profiles.find((p) => p.id === profileId);

  return (
    <div>
      <p className="mb-4 text-sm text-neutral-400">
        Everything BrainCue has ingested for this profile. Documents are parsed and indexed locally;
        only retrieved snippets are ever sent per question.
      </p>

      <Card className="mb-5">
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
      </Card>

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

          {/* STAR stories are an interview device — quarantined with the rest
              of the job-search surface (shared/flags.ts). */}
          <Card className={`flex items-center justify-between !py-4 ${FLAGS.jobSearch ? '' : 'hidden'}`}>
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
