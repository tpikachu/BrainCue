import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useLiveSession } from '../store/useLiveSession';
import { useSettingsStore } from '../store/useSettingsStore';
import { useReadiness, useReadinessStore } from '../store/useReadiness';
import { ACTIVITIES } from '@shared/activities';
import { cloudProvider } from '@shared/providers';
import type { Job, RememberResult, SessionMode } from '@shared/types';
import { Button, Field, Modal, Select, TextInput } from '../components/ui';
import { pickerOptions } from './startFlow';
import { failedHalves, keepPreview, keepResult, mergeRetry, type Line } from './keepCopy';

/** How many Spaces the picker loads at once; older ones are found by search. */
const PAGE = 100;

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

const spaceLabel = (s: Job) => `${s.title || 'Untitled'}${s.company ? ` · ${s.company}` : ''}`;

/** The picker's value for an explicit "no Space" — apart from the
 *  placeholder shown while the destination is unknown or must be chosen. */
const NONE = 'none';
const CHOOSE = '';
const GONE = 'That Space no longer exists — choose another, or keep it without one.';

/**
 * Where it will be filed, as far as the prompt KNOWS:
 *  - `resolving`: the Space it ran in is still being read;
 *  - `unknown`: that read FAILED — the Space may well still exist, so nothing
 *    is filed until it is read again or the user chooses (never a silent
 *    "no Space");
 *  - `choose`: the chosen Space was confirmed gone at Keep / Retry — the user
 *    picks again (another Space, or No Space) before anything runs;
 *  - `known`: `space` is the destination (null = No Space, chosen or — when
 *    the Space it ran in was confirmed gone on open — said).
 */
type Dest = 'resolving' | 'unknown' | 'choose' | 'known';

/**
 * The save-or-discard prompt — and the gate on remembering
 * (docs/16-CONTINUITY.md §9).
 *
 * The session and its transcript are already on this machine when it opens.
 * "Keep it" decides what may FOLLOW: a short summary and memory suggestions,
 * made by sending the transcript to the parsing provider and filed into the
 * chosen Space. The prompt says that before Keep is pressed (naming the
 * provider, or that nothing is sent), and afterwards reports each half as it
 * actually went — saved, switched off, nothing to do, or failed with a Retry —
 * never inferring a reason from a zero count.
 *
 * The destination is held as its own validated record, apart from the
 * picker's page: the Space it ran in is read by id (an older one is never
 * dropped for not being on the first page), re-read before Keep and before
 * every Retry (a deleted one is refused), and main validates it again (this
 * profile's, and still there). A destination that could not be READ is
 * unknown, not absent: Keep waits for a successful read or an explicit
 * choice, so a failed lookup never files the session out of its Space.
 *
 * A Retry re-runs only the half that failed, at the same destination; the
 * other half's confirmed outcome stands (and its transcript is not sent
 * again). A Retry's own errors, and a destination that has to be chosen
 * again, are shown on the result view itself.
 *
 * Rendered in App rather than on a page: sessions start from several places
 * and are usually STOPPED from the Cue Card, so the prompt has to appear
 * wherever the user happens to be.
 */
export function SavePromptModal() {
  const { pendingSave, clearPendingSave } = useLiveSession();
  const { settings, load: loadSettings } = useSettingsStore();
  const readiness = useReadiness();
  const refreshReadiness = useReadinessStore((s) => s.refresh);
  /** Where to keep it — validated (this session's profile), or none. */
  const [space, setSpace] = useState<Job | null>(null);
  const [dest, setDest] = useState<Dest>('known');
  /** Why the destination is unknown (the failed read). */
  const [lookupError, setLookupError] = useState<string | null>(null);
  /** Bumped by "Try again" — re-reads the Space it ran in. */
  const [lookups, setLookups] = useState(0);
  const [page, setPage] = useState<{ items: Job[]; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<false | 'keeping' | 'deleting'>(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<RememberResult | null>(null);
  /** Where `result` was filed. A Retry to the same place re-runs only what
   *  failed; a new destination runs both halves there. */
  const resultPack = useRef<string | null | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  /** The prompt this state belongs to: a reply for an earlier one is ignored. */
  const forSession = useRef<string | null>(null);
  /** Bumped by every explicit choice: a late lookup of the Space it ran in
   *  never overwrites a Space the user has since picked. */
  const choice = useRef(0);

  const profileId = pendingSave?.profileId ?? '';

  // A new prompt starts over.
  useEffect(() => {
    forSession.current = pendingSave?.sessionId ?? null;
    setSpace(null);
    setQuery('');
    setError(null);
    setNote(null);
    setResult(null);
    resultPack.current = undefined;
    setConfirmDiscard(false);
    setLookupError(null);
    setDest(pendingSave?.packId ? 'resolving' : 'known');
    if (!pendingSave) return;
    // Fresh: the prompt names who the transcript would go to.
    void loadSettings();
    void refreshReadiness();
  }, [pendingSave, loadSettings, refreshReadiness]);

  // The Space it ran in is read BY ID — wherever it sits in the list — on
  // open, and again on "Try again". Confirmed gone (or not this profile's):
  // No Space, said. The read FAILED: the destination stays unknown.
  useEffect(() => {
    if (!pendingSave?.packId) return;
    const sid = pendingSave.sessionId;
    const packId = pendingSave.packId;
    const gen = ++choice.current;
    const current = () => forSession.current === sid && choice.current === gen;
    setDest('resolving');
    setLookupError(null);
    void api.jobs
      .get(packId)
      .then((raw) => {
        if (!current()) return;
        const j = raw as Job | null;
        if (j && j.profileId === pendingSave.profileId) setSpace(j);
        else {
          setSpace(null);
          setNote('The Space it ran in no longer exists — choose another, or keep it without one.');
        }
        setDest('known');
      })
      .catch((e) => {
        if (!current()) return;
        setLookupError((e as Error)?.message || 'unknown error');
        setDest('unknown');
      });
  }, [pendingSave, lookups]);

  // One page of this profile's Spaces, searched when asked (server-side).
  useEffect(() => {
    if (!pendingSave) return;
    let alive = true;
    const t = setTimeout(() => {
      void api.jobs
        .page(profileId, query.trim(), PAGE, 0)
        .then(({ items, total }) => alive && setPage({ items: items as Job[], total }))
        .catch(() => alive && setPage({ items: [], total: 0 }));
    }, query ? 250 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pendingSave, profileId, query, reloads]);

  const options = pickerOptions(page?.items ?? [], space);
  const searchable = !!query || (!!page && page.total > page.items.length);
  const settled = dest === 'known';
  const providerName = (id: string | null | undefined) => (id ? (cloudProvider(id)?.name ?? id) : null);
  const preview = keepPreview({
    space: space ? { title: space.title || 'Untitled', remembers: space.memoryEnabled !== false } : null,
    archiveOn: settings?.sessionArchiveEnabled !== false,
    memoryOn: !!settings?.memoryEnabled,
    practice: pendingSave?.mode === 'practice',
    provider: providerName(readiness?.routes.parsing),
  });

  const isInterview = pendingSave?.mode === 'interview' || pendingSave?.mode === 'practice';
  const emptyish = (pendingSave?.turnCount ?? 0) < 4;

  /** An explicit pick (a Space, or No Space). */
  const choose = (value: string) => {
    if (value === CHOOSE) return;
    setSpace(value === NONE ? null : (options.find((s) => s.id === value) ?? null));
    // An explicit choice supersedes the lookup still in flight.
    choice.current += 1;
    setDest('known');
    setLookupError(null);
    setError(null);
    setNote(null);
  };

  /** The destination was confirmed gone: nothing runs until it is chosen. */
  const mustChoose = (message: string) => {
    setSpace(null);
    setDest('choose');
    setReloads((n) => n + 1);
    setError(message);
  };

  // Keep — and Retry, which re-runs only the failed halves when the
  // destination is the one the result was filed into.
  const keep = async () => {
    if (!pendingSave || busy || !settled) return;
    const sid = pendingSave.sessionId;
    const target = space?.id ?? null;
    setBusy('keeping');
    setError(null);
    try {
      // Re-read the chosen Space: one deleted (or not this profile's) since
      // it was chosen is never filed into. Main checks again. A read that
      // FAILS proves nothing — the choice stands, and nothing is sent.
      if (space) {
        let fresh: Job | null;
        try {
          fresh = (await api.jobs.get(space.id)) as Job | null;
        } catch (e) {
          if (forSession.current === sid) {
            setError(
              `Couldn’t check that “${space.title || 'Untitled'}” still exists (${(e as Error)?.message || 'unknown error'}). Nothing was sent — try again.`,
            );
          }
          return;
        }
        if (!fresh || fresh.profileId !== pendingSave.profileId) {
          if (forSession.current === sid) mustChoose(GONE);
          return;
        }
      }
      const only = result && resultPack.current === target ? failedHalves(result) : [];
      const r = await api.session.remember(sid, target, only.length ? only : undefined);
      if (forSession.current !== sid) return;
      setResult((prev) => (only.length ? mergeRetry(prev, r) : r));
      resultPack.current = target;
    } catch (e) {
      if (forSession.current !== sid) return;
      const message = (e as Error).message;
      // Main refused the destination (gone, or another profile's): choose again.
      if (/no longer exists|another profile/.test(message)) mustChoose(message);
      else {
        setError(message);
        setReloads((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!pendingSave || busy) return;
    setBusy('deleting');
    setError(null);
    try {
      await api.session.delete(pendingSave.sessionId);
      clearPendingSave();
    } catch (e) {
      // Not deleted: say so, and keep the prompt so it can be retried.
      setError(`It was not deleted (${(e as Error).message}). Try again, or delete it from Sessions.`);
    } finally {
      setBusy(false);
    }
  };

  const outcome = result
    ? keepResult(result, { space: space ? space.title || 'Untitled' : null, provider: providerName(result.provider) })
    : null;
  /** The Retry would file it somewhere other than the result's destination. */
  const moved = !!result && settled && resultPack.current !== (space?.id ?? null);

  const errorLine = error && (
    <p className="text-sm text-amber-400" role="alert">
      ⚠ {error}
    </p>
  );

  // A Space is what makes remembering possible at all: the summary and its
  // memories are scoped to one. A call started without one often turns out to
  // belong to one, so the choice is offered again here — and on the result
  // view whenever a Retry has to be filed somewhere new.
  const picker = (
    <Field label="File it in">
      <Select
        value={!settled ? CHOOSE : space ? space.id : NONE}
        onChange={(e) => choose(e.target.value)}
        disabled={!!busy}
      >
        {!settled && (
          <option value={CHOOSE} disabled>
            {dest === 'resolving' ? 'Checking the Space it ran in…' : 'Choose where to file it…'}
          </option>
        )}
        <option value={NONE}>No Space — keep the transcript only</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {spaceLabel(s)}
          </option>
        ))}
      </Select>
      {searchable && (
        <TextInput
          className="mt-2"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search older Spaces…"
          aria-label="Search Spaces"
        />
      )}
    </Field>
  );
  const destination = (
    <>
      {picker}
      {dest === 'unknown' && (
        <div className="flex items-start justify-between gap-2 text-xs text-amber-400" role="alert">
          <span>
            Couldn’t check the Space it ran in ({lookupError}). It may still exist — try again, or choose where to
            file it. Nothing is filed until then.
          </span>
          <Button variant="ghost" className="shrink-0" disabled={!!busy} onClick={() => setLookups((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}
    </>
  );

  return (
    <Modal
      open={!!pendingSave}
      // Escape / × / backdrop: before deciding it is "Decide later" (the
      // session stays, nothing is summarised); after Keep it is "Done".
      onClose={clearPendingSave}
      busy={busy === 'keeping' ? 'Keeping it' : busy === 'deleting' ? 'Deleting it' : false}
      title={endedTitle(pendingSave)}
      width="max-w-md"
    >
      {outcome ? (
        <div className="space-y-4">
          <ul className="space-y-1.5 text-sm" aria-label="What was kept">
            {outcome.lines.map((l) => (
              <ResultLine key={l.text} line={l} />
            ))}
          </ul>
          {/* A Retry whose destination was confirmed gone files nothing until
              the user chooses again — here, on the view they are looking at. */}
          {outcome.failed && (!settled || moved) && destination}
          {outcome.failed && moved && (
            <p className="text-xs text-neutral-400">
              Retry files it {space ? `into “${space.title || 'Untitled'}”` : 'without a Space'} and runs both halves
              there.
            </p>
          )}
          {errorLine}
          <div className="flex justify-end gap-2">
            {outcome.failed && (
              <Button variant="default" loading={busy === 'keeping'} disabled={!settled} onClick={() => void keep()}>
                Retry
              </Button>
            )}
            <Button variant="primary" disabled={!!busy} onClick={clearPendingSave}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-neutral-300">
            Keep this conversation?{' '}
            <span className="text-neutral-500">
              {emptyish
                ? 'Barely anything was captured.'
                : isInterview && pendingSave?.questionCount
                  ? `${pendingSave.questionCount} question${pendingSave.questionCount === 1 ? '' : 's'} captured.`
                  : `${pendingSave?.turnCount ?? 0} turns captured.`}
            </span>
          </p>

          {destination}

          {note && <p className="text-xs text-amber-400">{note}</p>}

          <ul className="space-y-1 rounded-lg border border-white/5 bg-neutral-950/60 px-3 py-2 text-xs leading-relaxed" aria-label="What Keep does">
            {preview.map((l) => (
              <ResultLine key={l.text} line={l} small />
            ))}
          </ul>

          {errorLine}

          {confirmDiscard ? (
            <div
              role="alertdialog"
              aria-label="Delete this session?"
              className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100"
            >
              <p>Delete this session, its transcript and anything it suggested? This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={!!busy} onClick={() => setConfirmDiscard(false)}>
                  Cancel
                </Button>
                <Button variant="danger" loading={busy === 'deleting'} onClick={() => void discard()}>
                  Delete it
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" className="text-red-300" disabled={!!busy} onClick={() => setConfirmDiscard(true)}>
                Discard…
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={!!busy} onClick={clearPendingSave}>
                  Decide later
                </Button>
                <Button variant="primary" loading={busy === 'keeping'} disabled={!settled} onClick={() => void keep()}>
                  Keep it
                </Button>
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-neutral-500">
            <strong className="font-medium text-neutral-400">Decide later</strong> keeps the session and its
            transcript in Sessions and sends nothing. <strong className="font-medium text-neutral-400">Discard</strong>{' '}
            deletes the session and its transcript.
          </p>
        </div>
      )}
    </Modal>
  );
}

function ResultLine({ line, small }: { line: Line; small?: boolean }) {
  const mark = line.tone === 'ok' ? '✓' : line.tone === 'error' ? '✕' : '–';
  const color = line.tone === 'ok' ? 'text-green-400' : line.tone === 'error' ? 'text-red-400' : 'text-neutral-500';
  return (
    <li className="flex gap-2">
      <span className={`w-3 shrink-0 text-center font-semibold ${color}`} aria-hidden>
        {mark}
      </span>
      <span className={line.tone === 'error' ? 'text-red-200' : small ? 'text-neutral-400' : 'text-neutral-300'}>
        {line.text}
      </span>
    </li>
  );
}
