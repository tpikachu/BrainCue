import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useProfileStore } from '../store/useProfileStore';
import { Button, Field, Modal, TextInput } from '../components/ui';

/**
 * Create a profile — the one thing BrainCue cannot work without.
 *
 * Two callers, deliberately ONE form: the sidebar switcher's "New profile…"
 * (this modal) and the first step of the onboarding flow
 * (`onboarding/Onboarding.tsx`), which renders `NewProfileForm` inline with
 * `firstRun` so "Try sample data" is reachable — the only page offering it is
 * behind the very gate a fresh install cannot pass.
 *
 * Name only. Everything else about a person — what they do, who they work
 * with, how they want to be helped — lives in the profile editor
 * (docs/17-SPACES-AND-PROFILE.md §2) and is optional there. Asking for it
 * before the app has done anything for them is how the old onboarding turned
 * into a job application.
 */
export function NewProfileForm(props: {
  /** First run has no dashboard behind it: offers sample data instead of Cancel. */
  firstRun?: boolean;
  onCreated?: (id: string) => void;
  onCancel?: () => void;
  /** Reset the field when this flips to true (a modal reopening). */
  active?: boolean;
}) {
  const { create, load } = useProfileStore();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRun = !!props.firstRun;

  const loadSamples = async () => {
    setSampling(true);
    setError(null);
    try {
      const res = (await api.data.loadSamples()) as { profileId: string };
      await api.settings.set({ activeProfileId: res.profileId });
      await load();
      props.onCreated?.(res.profileId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSampling(false);
    }
  };

  useEffect(() => {
    if (props.active !== false) {
      setName('');
      setError(null);
    }
  }, [props.active]);

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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-neutral-400">
        {firstRun
          ? 'BrainCue works for one person at a time. Tell it who you are and it can start listening; everything else is optional and can wait.'
          : 'A profile is one person BrainCue works for. Everything — Spaces, sessions, memory — belongs to one.'}
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

      <div className="flex items-center justify-end gap-2">
        {firstRun ? (
          <Button
            variant="ghost"
            className="mr-auto"
            loading={sampling}
            disabled={saving}
            onClick={() => void loadSamples()}
            title="Create a sample profile with a résumé and a few Spaces, to try the app"
          >
            Try sample data
          </Button>
        ) : (
          props.onCancel && (
            <Button variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
          )
        )}
        <Button
          variant="primary"
          disabled={!name.trim() || sampling}
          loading={saving}
          onClick={() => void submit()}
        >
          {firstRun ? 'Get started' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

/** The sidebar's "New profile…" — the form above in a dismissable dialog. */
export function NewProfileModal(props: { open: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="New profile" width="max-w-md">
      <NewProfileForm
        active={props.open}
        onCancel={props.onClose}
        onCreated={(id) => {
          props.onCreated?.(id);
          props.onClose();
        }}
      />
    </Modal>
  );
}
