import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useProfileStore } from '../store/useProfileStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLiveSession } from '../store/useLiveSession';
import type { Job, Presence } from '@shared/types';
import { Badge, Button, Field, Modal, Select } from '../components/ui';
import {
  PRESENCE_OPTIONS,
  captureSummary,
  enabledModes,
  startBlocker,
  type StartMode,
} from './startFlow';

/**
 * The universal start flow (docs/11-UX-NAVIGATION.md): one shared surface for
 * every mode — choose mode → Space → input source, see exactly what will be
 * captured and sent, and start only on the explicit button. Flag-gated modes
 * never appear. Practice routes to its drill pages (they own their own setup);
 * Interview starts the live session right here.
 */
export function StartSessionModal(props: {
  open: boolean;
  onClose: () => void;
  initialProfileId?: string;
  initialSpaceId?: string;
  initialMode?: StartMode['id'];
}) {
  const navigate = useNavigate();
  const { profiles, load: loadProfiles } = useProfileStore();
  const { settings, load: loadSettings } = useSettingsStore();
  const live = useLiveSession();

  const modes = enabledModes();
  const [mode, setMode] = useState<StartMode['id']>('interview');
  const [profileId, setProfileId] = useState(props.initialProfileId ?? '');
  const [spaceId, setSpaceId] = useState(props.initialSpaceId ?? '');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [source, setSource] = useState<'system' | 'mic'>('system');
  const [presence, setPresence] = useState<Presence>('quiet'); // meetings: quiet by default
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    void loadProfiles();
    void loadSettings();
    setMode(props.initialMode ?? 'interview');
    setProfileId(props.initialProfileId ?? '');
    setSpaceId(props.initialSpaceId ?? '');
    setPresence('quiet');
    setError(null);
  }, [
    props.open,
    props.initialProfileId,
    props.initialSpaceId,
    props.initialMode,
    loadProfiles,
    loadSettings,
  ]);

  // Default the source to the persisted audio preference.
  useEffect(() => {
    if (settings?.audio) setSource(settings.audio.source);
  }, [settings]);

  // Spaces are per-profile (they ground the answers in that profile's world).
  useEffect(() => {
    if (!props.open || !profileId) {
      setSpaces([]);
      return;
    }
    void api.jobs
      .page(profileId, '', 100, 0)
      .then(({ items }) => setSpaces(items as Job[]))
      .catch(() => setSpaces([]));
  }, [props.open, profileId]);

  const profile = profiles.find((p) => p.id === profileId);
  const space = spaces.find((s) => s.id === spaceId);
  const spaceTitle = space ? space.company || space.title : null;
  const blocker = startBlocker({
    profile,
    apiKeyPresent: !!settings?.apiKeyPresent,
    sessionLive: !!live.session,
  });
  const summary = useMemo(
    () => captureSummary({ source, spaceTitle, mode }),
    [source, spaceTitle, mode],
  );

  const start = async () => {
    if (blocker) return;
    setStarting(true);
    setError(null);
    try {
      // Persist the chosen source so the Cue Card + next session agree with it.
      await api.settings.set({ audio: { source, micDeviceId: settings?.audio?.micDeviceId ?? null } });
      await live.startNew({
        profileId,
        jobId: spaceId || null,
        interviewType: 'general',
        answerFormat: 'key_points',
        source,
        micDeviceId: settings?.audio?.micDeviceId ?? null,
        mode,
        presence: mode === 'meeting' ? presence : undefined,
      });
      props.onClose();
      // Interviews continue in their workspace; meetings live in the Cue Card.
      navigate(mode === 'meeting' ? '/home' : '/interview');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const goPractice = (path: '/mock' | '/sparring') => {
    props.onClose();
    navigate(path);
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title="Start a session" width="max-w-lg">
      <div className="space-y-5 text-sm">
        {/* 1 · Mode */}
        <fieldset>
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Mode
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
                className={`rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${
                  mode === m.id
                    ? 'border-indigo-400/50 bg-indigo-500/10'
                    : 'border-white/5 bg-neutral-900/60 hover:bg-neutral-900'
                }`}
              >
                <span className="flex items-center gap-1.5 font-medium text-neutral-100">
                  {m.label}
                  {m.id === 'meeting' && <Badge tone="amber">Labs</Badge>}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-neutral-400">{m.desc}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {mode === 'practice' ? (
          <div className="rounded-xl border border-white/5 bg-neutral-900/60 p-4">
            <p className="mb-3 text-neutral-300">
              Practice drills have their own setup — pick one:
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => goPractice('/mock')}>
                Mock interview
              </Button>
              <Button variant="primary" onClick={() => goPractice('/sparring')}>
                Sparring drill
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* 2 · Who + which Space grounds the answers */}
            <div className="grid gap-4 sm:grid-cols-2">
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
              <Field label="Space (optional)">
                <Select
                  value={spaceId}
                  onChange={(e) => setSpaceId(e.target.value)}
                  disabled={!profileId}
                >
                  <option value="">No Space — profile only</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || 'Untitled'}
                      {s.company ? ` · ${s.company}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* 3 · Input sources */}
            <fieldset>
              <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                Listen to
              </legend>
              <div className="flex gap-2" role="radiogroup" aria-label="Audio source">
                {(
                  [
                    ['system', 'System audio', 'the other side of your call'],
                    ['mic', 'Microphone', 'in-person / your own voice'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={source === value}
                    onClick={() => setSource(value)}
                    className={`flex-1 rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${
                      source === value
                        ? 'border-indigo-400/50 bg-indigo-500/10'
                        : 'border-white/5 bg-neutral-900/60 hover:bg-neutral-900'
                    }`}
                  >
                    <span className="block font-medium text-neutral-100">{label}</span>
                    <span className="mt-0.5 block text-xs text-neutral-400">{hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            {/* 3b · Presence — meetings only: explicit thresholds, not a vibe. */}
            {mode === 'meeting' && (
              <Field label="Presence">
                <Select value={presence} onChange={(e) => setPresence(e.target.value as Presence)}>
                  {PRESENCE_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label} — {p.desc}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {/* 4 · Exactly what is captured and sent — before anything starts. */}
            <div className="rounded-xl border border-white/5 bg-neutral-950/60 p-3.5 text-xs leading-relaxed">
              <p className="mb-1 font-medium text-neutral-300">Captured on this machine</p>
              <ul className="mb-2 list-disc space-y-0.5 pl-4 text-neutral-400">
                {summary.captured.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="mb-1 font-medium text-neutral-300">Sent to OpenAI (your key)</p>
              <ul className="mb-2 list-disc space-y-0.5 pl-4 text-neutral-400">
                {summary.sent.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="mb-1 font-medium text-neutral-300">Never sent</p>
              <ul className="list-disc space-y-0.5 pl-4 text-neutral-400">
                {summary.neverSent.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>

            {(blocker || error) && (
              <p className="text-xs text-amber-400" role="alert">
                ⚠ {error ?? blocker}
              </p>
            )}

            {/* 5 · Explicit start — nothing is captured until this click. */}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                variant="success"
                disabled={!!blocker}
                loading={starting}
                onClick={() => void start()}
              >
                Start listening
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
