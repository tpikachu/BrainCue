import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useActiveProfile } from '../store/useProfileStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLiveSession } from '../store/useLiveSession';
import { ACTIVITIES, DEFAULT_ACTIVITY } from '@shared/activities';
import type { CompanionPresence, ContextPackKind, Job, Presence } from '@shared/types';
import { COMPANION_TO_ENGINE_PRESENCE } from '@shared/types';
import { Button, Dropdown, Field, Modal, Select } from '../components/ui';
import {
  BUDGET_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  PRACTICE_LINKS,
  PRESENCE_OPTIONS,
  START_ACTIVITIES,
  captureSummary,
  startBlocker,
} from './startFlow';

/**
 * The universal start flow (docs/18-ACTIVITIES.md): one shared surface for
 * every conversation — say what the call is → who you are and what grounds it →
 * what it listens to, see exactly what will be captured and sent, and start
 * only on the explicit button.
 *
 * There is no mode picker. Choosing a mode AND a Space kind was the same
 * question asked twice, and answering it twice let the two disagree. The
 * activity resolves the mode; what that means for behaviour is printed on the
 * choice rather than hidden behind a second one.
 */
export function StartSessionModal(props: {
  open: boolean;
  onClose: () => void;
  initialSpaceId?: string;
  initialActivity?: ContextPackKind;
}) {
  const navigate = useNavigate();
  // Whose session this is was decided in the sidebar — the modal no longer asks.
  const profile = useActiveProfile();
  const profileId = profile?.id ?? '';
  const { settings, load: loadSettings } = useSettingsStore();
  const live = useLiveSession();

  const [activity, setActivity] = useState<ContextPackKind>(DEFAULT_ACTIVITY);
  const [spaceId, setSpaceId] = useState(props.initialSpaceId ?? '');
  const [spaces, setSpaces] = useState<Job[]>([]);
  const [source, setSource] = useState<'system' | 'mic'>('system');
  const [presence, setPresence] = useState<Presence>('quiet'); // meetings: quiet by default
  const [companionPresence, setCompanionPresence] = useState<CompanionPresence>('assistive');
  const [budgetCents, setBudgetCents] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = ACTIVITIES[activity] ?? ACTIVITIES[DEFAULT_ACTIVITY];
  const mode = config.mode;

  useEffect(() => {
    if (!props.open) return;
    void loadSettings();
    setActivity(props.initialActivity ?? DEFAULT_ACTIVITY);
    setSpaceId(props.initialSpaceId ?? '');
    setPresence('quiet');
    setError(null);
  }, [props.open, props.initialSpaceId, props.initialActivity, loadSettings]);

  // Companion defaults (posture + budget) come from the global companion config.
  useEffect(() => {
    if (settings?.companionPrefs) {
      setCompanionPresence(settings.companionPrefs.presence);
      setBudgetCents(settings.companionPrefs.budgetCents);
    }
  }, [settings]);

  // The activity sets what it listens to. A meeting is the other side of a call;
  // a solo session is you. Still a default, not a lock — an in-person meeting is
  // a microphone, and the control below stays live.
  useEffect(() => {
    setSource(config.listensTo);
  }, [config.listensTo]);

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

  // A Space IS a saved activity, so picking one answers the question — whether
  // it was picked here or arrived as `initialSpaceId` from the Library. Not a
  // lock: it only fires when the SPACE changes, so a job Space can still be
  // used for a Meeting (the recruiter call about that job is not an interview).
  useEffect(() => {
    const picked = spaces.find((s) => s.id === spaceId);
    if (picked?.kind && ACTIVITIES[picked.kind as ContextPackKind]) {
      setActivity(picked.kind as ContextPackKind);
    }
  }, [spaces, spaceId]);

  const space = spaces.find((s) => s.id === spaceId);
  const spaceTitle = space ? space.company || space.title : null;
  const blocker = startBlocker({
    profile,
    apiKeyPresent: !!settings?.apiKeyPresent,
    sessionLive: !!live.session,
    activity,
  });
  const summary = useMemo(
    () => captureSummary({ source, spaceTitle, activity }),
    [source, spaceTitle, activity],
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
        // No interviewType: it is chosen live in the Cue Card for interviews and
        // means nothing anywhere else. The session row keeps its 'general' default.
        // Companion replies are spoken persona prose, not glanceable cues.
        answerFormat: mode === 'companion' ? 'explanation' : 'key_points',
        source,
        micDeviceId: settings?.audio?.micDeviceId ?? null,
        activity,
        presence:
          mode === 'meeting'
            ? presence
            : mode === 'companion'
              ? COMPANION_TO_ENGINE_PRESENCE[companionPresence]
              : undefined,
        companionPresence: mode === 'companion' ? companionPresence : undefined,
        budgetCents: mode === 'companion' ? budgetCents : undefined,
      });
      props.onClose();
      // Interviews continue in their workspace; ambient sessions live in the Cue Card.
      navigate(mode === 'interview' ? '/interview' : '/home');
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
        {/* 1 · What is this? The only question about what BrainCue will be.
            A dropdown, not a card grid: eight tiles pushed the Space, the audio
            source, and the privacy summary below the fold, and the choice is
            one word — it does not need a card each. What the choice MEANS is
            printed underneath, so nothing the cards said is lost. */}
        <Field label="What’s this call?">
          <Dropdown
            value={activity}
            options={START_ACTIVITIES.map((a) => ({ value: a.id, label: a.label }))}
            onChange={(v) => setActivity(v as ContextPackKind)}
          />
          <p className="mt-1.5 text-xs leading-snug text-neutral-400">
            {config.hint} <span className="text-neutral-500">{config.does}</span>
          </p>
        </Field>

        {/* 1b · Practice is preparation FOR an interview, not a kind of call. */}
        {activity === 'job' && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/5 bg-neutral-900/60 p-3">
            <span className="text-xs text-neutral-400">Not the real thing yet?</span>
            {PRACTICE_LINKS.map((p) => (
              <Button key={p.to} variant="ghost" onClick={() => goPractice(p.to)}>
                {p.label}
              </Button>
            ))}
          </div>
        )}

        {/* 2 · Which Space grounds the answers. The profile is the sidebar's. */}
        <Field label={`Space (optional) · ${profile?.name ?? 'no profile'}`}>
          <Select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={!profileId}>
            <option value="">No Space — profile only</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || 'Untitled'}
                {s.company ? ` · ${s.company}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        {/* 3 · Input source. Defaulted by the activity, still yours to change. */}
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

        {/* 3b · Presence — how present it should be. The one dial that genuinely
            varies WITHIN an activity, so it stays a question. */}
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

        {/* 3c · Companion posture + hard budget — the InterjectionPolicy's
            explicit dials, chosen before anything starts. */}
        {mode === 'companion' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Presence">
              <Select
                value={companionPresence}
                onChange={(e) => setCompanionPresence(e.target.value as CompanionPresence)}
              >
                {COMPANION_PRESENCE_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label} — {p.desc}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Session budget">
              <Select
                value={budgetCents === null ? '' : String(budgetCents)}
                onChange={(e) =>
                  setBudgetCents(e.target.value === '' ? null : Number(e.target.value))
                }
              >
                {BUDGET_OPTIONS.map((b) => (
                  <option key={b.label} value={b.value === null ? '' : String(b.value)}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
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
      </div>
    </Modal>
  );
}
