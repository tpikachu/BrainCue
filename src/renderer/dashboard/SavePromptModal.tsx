import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useLiveSession } from '../store/useLiveSession';
import type { InterviewType } from '@shared/types';
import { Button, Field, Modal, Select } from '../components/ui';

const INTERVIEW_TYPES: { value: InterviewType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'coding', label: 'Coding' },
  { value: 'system_design', label: 'System design' },
  { value: 'product', label: 'Product' },
  { value: 'sales', label: 'Sales' },
];

/** Global "Interview ended" save-or-discard prompt. Rendered in App (not a page):
 *  sessions can be started from several pages (Interview, Tailor Resume) and are
 *  usually STOPPED from the Cue Card — the prompt must appear wherever the user is. */
export function SavePromptModal() {
  const { pendingSave, clearPendingSave } = useLiveSession();
  const [saveType, setSaveType] = useState<InterviewType>('general');

  useEffect(() => {
    if (pendingSave) setSaveType(pendingSave.interviewType);
  }, [pendingSave]);

  const save = async () => {
    if (!pendingSave) return;
    await api.session.setInterviewType(pendingSave.sessionId, saveType);
    clearPendingSave();
  };
  const discard = async () => {
    if (!pendingSave) return;
    await api.session.delete(pendingSave.sessionId);
    clearPendingSave();
  };

  return (
    <Modal open={!!pendingSave} onClose={clearPendingSave} title="Interview ended" width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Save this interview{pendingSave?.jobTitle ? ` for “${pendingSave.jobTitle}”` : ''}?{' '}
          <span className="text-neutral-500">
            {pendingSave?.questionCount
              ? `${pendingSave.questionCount} question${pendingSave.questionCount === 1 ? '' : 's'} captured.`
              : 'No questions were captured.'}
          </span>
        </p>
        <Field label="What kind of interview was this?">
          <Select value={saveType} onChange={(e) => setSaveType(e.target.value as InterviewType)}>
            {INTERVIEW_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" className="text-red-300" onClick={() => void discard()}>
            Discard
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={clearPendingSave}>
              Decide later
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              Save to Reports
            </Button>
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          “Discard” permanently deletes this session and its transcript. “Decide later” keeps it
          for now — you can delete it from Reports.
        </p>
      </div>
    </Modal>
  );
}
