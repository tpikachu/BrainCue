import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useActiveProfile } from '../store/useProfileStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLiveSession } from '../store/useLiveSession';
import { useReadiness, useReadinessStore } from '../store/useReadiness';
import { ACTIVITIES, DEFAULT_ACTIVITY, activityOf } from '@shared/activities';
import type { CompanionPresence, ContextPackKind, Job, Presence, SessionListItem } from '@shared/types';
import { COMPANION_TO_ENGINE_PRESENCE } from '@shared/types';
import { Button, Dropdown, Field, Modal, Select } from '../components/ui';
import { JobFormModal } from './JobFormModal';
import { EDIT_ROLE, ReadinessChecklist } from './ReadinessChecklist';
import { chatLabel } from './setupChecklistState';
import {
  BUDGET_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  PRACTICE_LINKS,
  PRESENCE_OPTIONS,
  START_ACTIVITIES,
  captureSummary,
  nextSpaceChoice,
  startBlocker,
} from './startFlow';

/**
 * The ONE start flow (docs/18-ACTIVITIES.md, docs/23-INTERVIEW-COPILOT.md §7).
 *
 * For an interview — the primary feature — it is short: which role, one line
 * each for résumé, role & JD, audio and AI (each gap names its fix), and an
 * explicit Start. The role a returning user last interviewed for is already
 * chosen, so Home → Start interview → Start is the whole path. The Interview
 * page's per-role Start opens this same flow rather than starting on its own.
 *
 * Every other conversation starts here too ("Other conversation" on Home, or a
 * Space in the Library): then the activity is asked, because it is the
 * question — the activity resolves the engine mode, never a mode picker.
 *
 * Nothing is captured before Start. What is captured and what is sent (to
 * which provider) is one click away in the disclosure above the button.
 */
export function StartSessionModal(props: {
  open: boolean;
  onClose: () => void;
  initialSpaceId?: string;
  initialActivity?: ContextPackKind;
}) {
  const navigate = useNavigate();
  // Whose session this is was decided in the sidebar — the modal never asks.
  const profile = useActiveProfile();
  const profileId = profile?.id ?? '';
  const { settings, load: loadSettings } = useSettingsStore();
  const live = useLiveSession();
  const readiness = useReadiness();
  const refreshReadiness = useReadinessStore((s) => s.refresh);

  const [activity, setActivity] = useState<ContextPackKind>(DEFAULT_ACTIVITY);
  /** Ask "what's this call?" — not for an interview: that is already known. */
  const [askActivity, setAskActivity] = useState(false);
  /** Spaces OF the current activity, for the current profile (server-filtered). */
  const [spaces, setSpaces] = useState<{ key: string; items: Job[] } | null>(null);
  const [sessions, setSessions] = useState<{ profileId: string; items: SessionListItem[] } | null>(null);
  const [spaceId, setSpaceId] = useState('');
  /** The user (or the caller) chose the Space; the default no longer applies. */
  const [chosen, setChosen] = useState(false);
  /** A Space handed in is being read to learn its activity — hold the default. */
  const [resolving, setResolving] = useState(false);
  const [presence, setPresence] = useState<Presence>('balanced'); // meetings: answer questions asked in the room
  const [companionPresence, setCompanionPresence] = useState<CompanionPresence>('assistive');
  const [budgetCents, setBudgetCents] = useState<number | null>(null);
  /** The role/Space form, replacing this modal while open: new, or editing one. */
  const [form, setForm] = useState<null | 'new' | Job>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = ACTIVITIES[activity] ?? ACTIVITIES[DEFAULT_ACTIVITY];
  const mode = config.mode;
  const interview = activity === 'job';
  const spacesKey = `${profileId}|${activity}`;

  // Reset on open. A Space handed in (Library, Interview page) answers the
  // activity — read from the Space itself, since lists are per activity.
  useEffect(() => {
    if (!props.open) return;
    void loadSettings();
    void refreshReadiness();
    const initial = props.initialActivity ?? DEFAULT_ACTIVITY;
    setActivity(initial);
    setAskActivity(initial !== 'job');
    setSpaceId(props.initialSpaceId ?? '');
    setChosen(!!props.initialSpaceId);
    setPresence('balanced');
    setForm(null);
    setError(null);
    setResolving(!!props.initialSpaceId);
    if (props.initialSpaceId) {
      void api.jobs
        .get(props.initialSpaceId)
        .then((j) => {
          const a = activityOf((j as Job).kind);
          setActivity(a);
          setAskActivity(a !== 'job');
        })
        .catch(() => {})
        .finally(() => setResolving(false));
    }
  }, [props.open, props.initialSpaceId, props.initialActivity, loadSettings, refreshReadiness]);

  // A profile switch makes every Space choice stale: start over from its default.
  useEffect(() => {
    setChosen(false);
    setSpaceId('');
  }, [profileId]);

  // Companion defaults (posture + budget) come from the global companion config.
  useEffect(() => {
    if (settings?.companionPrefs) {
      setCompanionPresence(settings.companionPrefs.presence);
      setBudgetCents(settings.companionPrefs.budgetCents);
    }
  }, [settings]);

  // The Spaces of THIS activity, server-side — so a profile with many Spaces
  // of other kinds can never push the interview roles off the page.
  useEffect(() => {
    if (!props.open || !profileId) {
      setSpaces(null);
      return;
    }
    let alive = true;
    const key = spacesKey;
    void api.jobs
      .page(profileId, '', 100, 0, activity)
      .then(({ items }) => alive && setSpaces({ key, items: items as Job[] }))
      .catch(() => alive && setSpaces({ key, items: [] }));
    return () => {
      alive = false;
    };
  }, [props.open, profileId, activity, spacesKey]);

  // This profile's sessions — what the user actually chose last time.
  useEffect(() => {
    if (!props.open || !profileId) {
      setSessions(null);
      return;
    }
    let alive = true;
    void api.session
      .list(profileId)
      .then((all) => alive && setSessions({ profileId, items: all as SessionListItem[] }))
      .catch(() => alive && setSessions({ profileId, items: [] }));
    return () => {
      alive = false;
    };
  }, [props.open, profileId, live.session]);

  // Only lists that belong to the current profile and activity count.
  const options = useMemo(() => (spaces?.key === spacesKey ? spaces.items : null), [spaces, spacesKey]);
  const history = sessions?.profileId === profileId ? sessions.items : null;

  // The default Space: the last one used for this activity (or the only one
  // an interview could use). A choice that no longer exists — deleted, or
  // another profile's — is dropped rather than started against.
  useEffect(() => {
    if (resolving) return;
    const next = nextSpaceChoice({ activity, spaces: options, sessions: history, spaceId, chosen });
    if (!next) return;
    setChosen(next.chosen);
    setSpaceId(next.spaceId);
  }, [options, history, chosen, spaceId, activity, resolving]);

  const space = options?.find((s) => s.id === spaceId);
  const spaceTitle = space ? space.company || space.title : null;
  const blocker = !readiness
    ? null // still checking — Start stays disabled below, without a false alarm
    : startBlocker({
        profile,
        chatReady: readiness.chat.ready,
        chatProblem: readiness.chat.problem,
        sttReady: readiness.transcription.ready,
        sttProblem: readiness.transcription.problem,
        sessionLive: !!live.session,
        activity,
        spaceId: space ? spaceId : '',
      });
  const summary = captureSummary({
    listensTo: config.listensTo,
    spaceTitle,
    activity,
    sttEngine: readiness?.transcription.engine,
    chatProvider: readiness?.chat.ready ? chatLabel(readiness).split(' · ')[0] : undefined,
  });

  const start = async () => {
    if (blocker || !readiness) return;
    setStarting(true);
    setError(null);
    try {
      const started = await live.startNew({
        profileId,
        jobId: space ? spaceId : null,
        // No interviewType: it is chosen live in the Cue Card for interviews and
        // means nothing anywhere else. The session row keeps its 'general' default.
        // One answer style for every mode; the Cue Card's General | Technical
        // chip switches it live. (Companion speaks its own persona prose.)
        answerFormat: 'general',
        // What it hears is the activity's call (shared/activities.ts): a call
        // is the call AND your microphone, a solo session is your microphone.
        listensTo: config.listensTo,
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
      // Nothing is flowing: stay open and say why (the streams are released
      // and no session is left running).
      if (!started.ok) {
        setError(started.error);
        return;
      }
      props.onClose();
      // Interviews continue in their workspace; ambient sessions live in the Cue Card.
      navigate(mode === 'interview' ? '/interview' : '/home');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const go = (to: string) => {
    if (to === EDIT_ROLE) {
      if (space) setForm(space);
      return;
    }
    props.onClose();
    navigate(to);
  };

  /** A Space created or edited here is the one about to be used. Closing the
   *  form is its own call: it stays open to report a link it could not read. */
  const spaceSaved = (saved: Job) => {
    setSpaces((prev) =>
      prev && prev.key === spacesKey ? { key: prev.key, items: [saved, ...prev.items.filter((s) => s.id !== saved.id)] } : prev,
    );
    setSpaceId(saved.id);
    setChosen(true);
  };

  const roleLabel = (s: Job) => `${s.title || 'Untitled'}${s.company ? ` · ${s.company}` : ''}`;

  return (
    <>
      {/* The role/Space form REPLACES this modal rather than stacking on it:
          the start form's state lives here, so it survives untouched and comes
          back with the new or edited role chosen. */}
      <JobFormModal
        open={props.open && form !== null}
        profileId={profileId}
        job={form && form !== 'new' ? form : null}
        initialKind={activity}
        lockKind
        onClose={() => setForm(null)}
        onSaved={spaceSaved}
      />
      <Modal
        open={props.open && form === null}
        onClose={props.onClose}
        title={interview ? 'Start an interview' : 'Start a session'}
        width="max-w-lg"
      >
        <div className="space-y-4 text-sm">
          {/* What is this? Asked only when it is the question — "Other
              conversation", or a Space of another kind. */}
          {askActivity && (
            <Field label="What’s this call?">
              <Dropdown
                value={activity}
                options={START_ACTIVITIES.map((a) => ({ value: a.id, label: a.label }))}
                onChange={(v) => {
                  setActivity(v as ContextPackKind);
                  // A Space of the previous activity is not offered for this
                  // one; its own default applies instead.
                  setChosen(false);
                  setSpaceId('');
                }}
              />
              <p className="mt-1.5 text-xs leading-snug text-neutral-400">{config.hint}</p>
            </Field>
          )}

          {/* Which role (an interview) or Space (anything else). */}
          <Field label={interview ? 'Role' : `${config.label} Space${config.needsSpace ? '' : ' (optional)'}`}>
            <div className="flex gap-2">
              <Select
                value={space ? spaceId : ''}
                onChange={(e) => {
                  setSpaceId(e.target.value);
                  setChosen(true);
                }}
                disabled={!profileId || !options}
                className="flex-1"
              >
                <option value="">
                  {!options
                    ? 'Loading…'
                    : interview
                      ? options.length === 0
                        ? 'No roles yet — add one'
                        : 'Choose a role…'
                      : config.needsSpace
                        ? 'Choose a Space…'
                        : 'None — keep nothing afterwards'}
                </option>
                {(options ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {roleLabel(s)}
                  </option>
                ))}
              </Select>
              <Button variant="default" disabled={!profileId} onClick={() => setForm('new')}>
                {interview ? 'New role' : 'New Space'}
              </Button>
            </div>
            {/* Interviews: the rows below already say what is missing. */}
            {!interview && (
              <p className="mt-1.5 text-xs leading-snug text-neutral-400">
                {spaceId
                  ? 'Grounded in this Space, and what you keep is filed back into it.'
                  : 'Without one, nothing is summarised or remembered afterwards.'}
              </p>
            )}
          </Field>

          {/* One line each: résumé, role & JD (interviews), audio, AI. */}
          <ReadinessChecklist
            profile={profile}
            space={space}
            interview={!!config.needsResume}
            listensTo={config.listensTo}
            readiness={readiness}
            onGo={go}
          />

          {/* Presence — the one dial that genuinely varies WITHIN an activity. */}
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

          {/* Companion posture + hard budget, chosen before anything starts. */}
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
                  onChange={(e) => setBudgetCents(e.target.value === '' ? null : Number(e.target.value))}
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

          {/* Consent: what is captured and what leaves the machine, for THIS
              session (engine and provider included) — one click away. */}
          <details className="rounded-xl border border-white/5 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400">
            <summary className="cursor-pointer select-none text-neutral-300">
              Nothing is recorded until you press Start · what is captured and sent
            </summary>
            <div className="mt-2 space-y-2 leading-snug">
              <DisclosureList title="Captured on this machine" items={summary.captured} />
              <DisclosureList title="Sent" items={summary.sent} />
              <DisclosureList title="Never sent" items={summary.neverSent} />
            </div>
          </details>

          {/* Résumé, role, transcription and AI gaps are already on their rows,
              each with its fix — said once. Only what no row shows (a live
              session, no profile) or a failed start is said here. */}
          {(error || (blocker && (!profile || live.session))) && (
            <p className="text-xs text-amber-400" role="alert">
              ⚠ {error ?? blocker}
            </p>
          )}

          {/* Explicit start — nothing is captured until this click. Practice
              (preparation FOR an interview, not a kind of call) is one quiet link. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {interview && (
              <span className="mr-auto text-xs text-neutral-500">
                Practice first:{' '}
                {PRACTICE_LINKS.map((p, i) => (
                  <span key={p.to}>
                    {i > 0 && ' · '}
                    <button type="button" className="text-neutral-400 hover:text-neutral-200" onClick={() => go(p.to)}>
                      {p.label}
                    </button>
                  </span>
                ))}
              </span>
            )}
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="success" disabled={!!blocker || !readiness} loading={starting} onClick={() => void start()}>
              {interview ? 'Start interview' : 'Start listening'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function DisclosureList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="font-medium text-neutral-300">{title}</div>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
