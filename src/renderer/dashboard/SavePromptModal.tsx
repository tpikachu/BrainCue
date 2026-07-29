import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useLiveSession } from '../store/useLiveSession';
import { ACTIVITIES } from '@shared/activities';
import type { InterviewType, Job, SessionMode } from '@shared/types';
import { Button, Field, Modal, Select } from '../components/ui';

const INTERVIEW_TYPES: { value: InterviewType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'coding', label: 'Coding' },
  { value: 'system_design', label: 'System design' },
];

/** Fallback only — for rehearsals and v1 rows, which carry no activity. When
 *  there is one, the prompt names the thing that ended ("Game ended") rather
 *  than the pipeline it happened to run through. */
const TITLE: Partial<Record<SessionMode, string>> = {
  interview: 'Interview ended',
  practice: 'Practice ended',
  meeting: 'Conversation ended',
  companion: 'Session ended',
};

const endedTitle = (p: { activity?: string | null; mode?: SessionMode } | null): string => {
  const label = p?.activity ? ACTIVITIES[p.activity as keyof typeof ACTIVITIES]?.label : null;
  if (label) return `${label} ended`;
  return TITLE[p?.mode ?? 'interview'] ?? 'Session ended';
};

/**
 * The save-or-discard prompt — and the gate on remembering
 * (docs/16-CONTINUITY.md §9).
 *
 * Keeping a conversation is what archives it for later retrieval and what sends
 * its memory candidates to review. Neither happens at stop: "keep this?" is a
 * question about the conversation, and answering it afterwards would mean
 * Discard had to undo work that should never have started.
 *
 * Rendered in App rather than on a page: sessions start from several places and
 * are usually STOPPED from the Cue Card, so the prompt has to appear wherever
 * the user happens to be.
 */
export function SavePromptModal() {
  const { pendingSave, clearPendingSave } = useLiveSession();
  const [saveType, setSaveType] = useState<InterviewType>('general');
  // Where to keep it. Defaults to the Space the session ran in; '' means keep
  // it on the profile and out of every Space.
  const [packId, setPackId] = useState<string>('');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingSave) return;
    setSaveType(pendingSave.interviewType);
    setPackId(pendingSave.packId ?? '');
    setResult(null);
    // A call you did not set a Space for often turns out to belong to one, so
    // the choice is offered here rather than being fixed at start.
    void api.jobs
      .page(pendingSave.profileId, '', 100, 0)
      .then(({ items }) => setSpaces(items as Job[]))
      .catch(() => setSpaces([]));
  }, [pendingSave]);

  const isInterview = pendingSave?.mode === 'interview' || pendingSave?.mode === 'practice';
  const emptyish = (pendingSave?.turnCount ?? 0) < 4;

  const save = async () => {
    if (!pendingSave) return;
    setBusy(true);
    try {
      if (isInterview) await api.session.setInterviewType(pendingSave.sessionId, saveType);
      const { archived, memories } = await api.session.remember(
        pendingSave.sessionId,
        packId || null,
      );
      // Say what was actually kept. Both halves are gated by the user's own
      // settings, so zero is a legitimate outcome and should read as one.
      if (archived === 0 && memories === 0) {
        setResult(
          packId
            ? 'Saved. Remembering is off, so nothing was summarised.'
            : 'Saved with no Space — nothing was summarised or remembered.',
        );
        setTimeout(clearPendingSave, 1800);
      } else {
        clearPendingSave();
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!pendingSave) return;
    setBusy(true);
    try {
      await api.session.delete(pendingSave.sessionId);
      clearPendingSave();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!pendingSave}
      onClose={clearPendingSave}
      title={endedTitle(pendingSave)}
      width="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Keep this conversation{pendingSave?.jobTitle ? ` in “${pendingSave.jobTitle}”` : ''}?{' '}
          <span className="text-neutral-500">
            {emptyish
              ? 'Barely anything was captured.'
              : isInterview && pendingSave?.questionCount
                ? `${pendingSave.questionCount} question${pendingSave.questionCount === 1 ? '' : 's'} captured.`
                : `${pendingSave?.turnCount ?? 0} turns captured.`}
          </span>
        </p>

        {/* A Space is what makes remembering possible at all: the archive and
            its memories are scoped to one, which is what makes a recurring
            meeting accumulate instead of leaking into unrelated calls. A call
            started without one often turns out to belong to one, so the choice
            is offered again here — and this is the last time it is asked. */}
        <Field label="Remember it in">
          <Select value={packId} onChange={(e) => setPackId(e.target.value)}>
            <option value="">No Space — remember nothing</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || 'Untitled'}
                {s.company ? ` · ${s.company}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <p className="rounded-lg border border-white/5 bg-neutral-950/60 px-3 py-2 text-xs leading-relaxed text-neutral-400">
          {packId ? (
            <>
              Keeping it saves a short summary — what it was about, what was decided, who committed
              to what, and a few lines in the speakers&rsquo; own words — plus memory suggestions
              for you to review. Both file into that Space, so the next conversation there starts
              where this one ended. Everything stays on this machine.
            </>
          ) : (
            <>
              Without a Space there is nowhere to file a summary, so nothing is summarised and
              nothing is suggested for memory. The session and its transcript are still saved and
              readable in Sessions — they just will not ground a later conversation. Pick a Space
              above if this one should carry forward.
            </>
          )}
        </p>

        {isInterview && (
          <Field label="What kind of interview was this?">
            <Select value={saveType} onChange={(e) => setSaveType(e.target.value as InterviewType)}>
              {INTERVIEW_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {result && <p className="text-sm text-emerald-300">{result}</p>}

        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" className="text-red-300" loading={busy} onClick={() => void discard()}>
            Discard
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={clearPendingSave}>
              Decide later
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Keep it
            </Button>
          </div>
        </div>

        <p className="text-xs text-neutral-500">
          “Discard” permanently deletes this session, its transcript, and any memories it suggested.
          “Decide later” keeps the session but remembers nothing — it stays readable in Sessions,
          where you can also delete it.
        </p>
      </div>
    </Modal>
  );
}
