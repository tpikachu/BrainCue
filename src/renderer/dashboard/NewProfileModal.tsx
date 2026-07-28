import { useEffect, useState } from 'react';
import { useProfileStore } from '../store/useProfileStore';
import { Button, Field, Modal, TextInput } from '../components/ui';

/**
 * Create a profile — the one thing BrainCue cannot work without.
 *
 * Two callers, deliberately the same component: the sidebar switcher's "New
 * profile…", and the first-run gate (`dismissable={false}`), where there is
 * nothing to go back to. An empty app used to render every surface as an empty
 * list with a profile picker containing nothing, which reads as broken rather
 * than as "start here".
 *
 * Name only. Everything else about a person — what they do, who they work
 * with, how they want to be helped — lives in the profile editor
 * (docs/17-SPACES-AND-PROFILE.md §2) and is optional there. Asking for it
 * before the app has done anything for them is how the old onboarding turned
 * into a job application.
 */
export function NewProfileModal(props: {
  open: boolean;
  onClose: () => void;
  /** First run has nothing behind it — no Escape, no Cancel. */
  dismissable?: boolean;
  onCreated?: (id: string) => void;
}) {
  const create = useProfileStore((s) => s.create);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissable = props.dismissable !== false;

  useEffect(() => {
    if (props.open) {
      setName('');
      setError(null);
    }
  }, [props.open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const profile = await create({
        name: trimmed,
        targetRole: '',
        targetCompany: null,
        interviewType: 'general',
        language: 'en',
        resumeText: null,
        jdText: null,
      });
      props.onCreated?.(profile.id);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={dismissable ? props.onClose : () => {}}
      title={dismissable ? 'New profile' : 'Welcome to BrainCue'}
      width="max-w-md"
    >
      <div className="space-y-4 text-sm">
        <p className="text-neutral-400">
          {dismissable
            ? 'A profile is one person BrainCue works for. Everything — Spaces, sessions, memory — belongs to one.'
            : 'BrainCue works for one person at a time. Tell it who you are and it can start listening; everything else is optional and can wait.'}
        </p>

        <Field label="Your name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="e.g. Jordan Lee"
          />
        </Field>

        {error && (
          <p className="text-xs text-amber-400" role="alert">
            ⚠ {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {dismissable && (
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={saving}
            onClick={() => void submit()}
          >
            {dismissable ? 'Create' : 'Get started'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
