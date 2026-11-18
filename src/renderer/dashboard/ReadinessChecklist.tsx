import { useEffect, useState } from 'react';
import type { Job, Profile, Readiness } from '@shared/types';
import { cloudProvider } from '@shared/providers';
import { chatLabel } from './setupChecklistState';

/**
 * The setup summary shown before Start (docs/23-INTERVIEW-COPILOT.md §7):
 * ONE line each for what an interview depends on — résumé, role & JD, audio,
 * AI — so a gap is seen before the call, never discovered in it. A row that is
 * fine is a few words; a row that is not says what is wrong and offers the
 * fix. The longer explanation (why this model, how documents are matched)
 * stays one hover away instead of filling the form.
 *
 * Audio and AI come from main's readiness (services/readiness.ts), so any
 * provider with a key reads as ready and on-device transcription needs no key.
 */

/** A row action that is not a route: open the selected role's form in place
 *  (its job description), instead of leaving the start flow for the Library. */
export const EDIT_ROLE = '#edit-role';

export interface ChecklistProps {
  profile: Profile | undefined;
  space: Job | undefined;
  /** Interview-shaped rows (résumé, role & JD) — only for activities that use them. */
  interview: boolean;
  listensTo: 'system' | 'mic';
  readiness: Readiness | null;
  /** Resuming an interview whose role was deleted: there is no picker to
   *  choose another, so the row says what happened instead. */
  roleGone?: boolean;
  /** A route, or `EDIT_ROLE`. */
  onGo: (to: string) => void;
}

type Tone = 'ok' | 'warn' | 'block';
export interface RowState {
  tone: Tone;
  text: string;
  /** The long explanation, kept off the form: shown on hover AND on keyboard
   *  focus (the row is focusable when it has one), and read by screen readers. */
  detail?: string;
  /** The concrete fix, shown UNDER a blocked row — never only on hover. */
  fix?: string;
  action?: { label: string; to: string };
}

function Row(props: RowState & { label: string; onGo: (p: string) => void }) {
  const mark = props.tone === 'ok' ? '✓' : props.tone === 'warn' ? '!' : '✕';
  const color = props.tone === 'ok' ? 'text-green-400' : props.tone === 'warn' ? 'text-amber-400' : 'text-red-400';
  return (
    <li
      className="flex items-start gap-2 rounded py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
      title={props.detail}
      tabIndex={props.detail ? 0 : undefined}
    >
      <span className={`w-3 shrink-0 text-center font-semibold ${color}`} aria-hidden>
        {mark}
      </span>
      <span className="w-20 shrink-0 font-medium text-neutral-200">{props.label}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${props.tone === 'ok' ? 'text-neutral-400' : 'text-neutral-300'}`}>{props.text}</span>
        {props.fix && <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{props.fix}</span>}
        {props.detail && <span className="sr-only">{props.detail}</span>}
      </span>
      {props.action && (
        <button
          type="button"
          onClick={() => props.onGo(props.action!.to)}
          className="shrink-0 text-xs font-medium text-indigo-300 hover:text-indigo-200"
        >
          {props.action.label} →
        </button>
      )}
    </li>
  );
}

/** The AI row's few words when it is blocked, from main's `blocked` list:
 *  the provider that is ACTUALLY missing its key and what it would do. With
 *  no key at all, there is no provider to name. */
export function blockedText(blocked: Readiness['chat']['blocked']): string {
  if (!blocked?.length) return 'no AI provider key yet';
  const nameOf = (p: string) => cloudProvider(p)?.name ?? p;
  const what = (t: 'answer' | 'classify') => (t === 'answer' ? 'answers' : 'question detection');
  const byProvider = new Map<string, string[]>();
  for (const b of blocked) byProvider.set(b.provider, [...(byProvider.get(b.provider) ?? []), what(b.task)]);
  return [...byProvider].map(([p, tasks]) => `no ${nameOf(p)} key (${tasks.join(', ')})`).join('; ');
}

/** Pure: the row states, exported for tests. */
export function checklistRows(
  p: Omit<ChecklistProps, 'onGo'> & { hasMic: boolean | null },
): { label: string; state: RowState }[] {
  const { profile, space, interview, listensTo, readiness, hasMic, roleGone } = p;
  const rows: { label: string; state: RowState }[] = [];

  if (interview) {
    rows.push({
      label: 'Résumé',
      state: !profile
        ? { tone: 'block', text: 'no profile selected' }
        : profile.parsedResume
          ? { tone: 'ok', text: profile.name }
          : profile.resumeText?.trim()
            ? {
                tone: 'block',
                text: 'saved but not read yet',
                detail: 'Open the profile and save it again so the résumé is read.',
                action: { label: 'Fix', to: `/profiles/${profile.id}` },
              }
            : {
                tone: 'block',
                text: 'not added yet',
                detail: 'Answers are written from your résumé — without one they have nothing of yours to draw on.',
                action: { label: 'Add', to: `/profiles/${profile.id}` },
              },
    });
    const role = space ? `${space.title || 'Untitled'}${space.company ? ` · ${space.company}` : ''}` : '';
    rows.push({
      label: 'Role & JD',
      state: !space
        ? roleGone
          ? { tone: 'block', text: 'deleted — start a new interview' }
          : // The role picker above is the fix; no second "choose a role" link.
            { tone: 'block', text: 'choose the role above' }
        : space.parsedJd || space.jdText?.trim()
          ? { tone: 'ok', text: role }
          : {
              tone: 'warn',
              text: `${role} · no job description`,
              detail: "Without the job description, answers won't know what the role asks for.",
              action: { label: 'Add JD', to: EDIT_ROLE },
            },
    });
  }

  // Audio = what it hears AND how it is transcribed.
  const heard = listensTo === 'system' ? 'call + your mic' : 'your mic';
  const engine = readiness?.transcription.engine === 'local' ? 'on-device transcription' : 'OpenAI transcription';
  rows.push({
    label: 'Audio',
    state: !readiness
      ? { tone: 'warn', text: 'checking…' }
      : !readiness.transcription.ready
        ? {
            // A few words on the row; main's full sentence and fix on hover.
            tone: 'block',
            text:
              readiness.transcription.engine === 'local'
                ? 'on-device model not downloaded'
                : 'cloud transcription needs an OpenAI key',
            detail: readiness.transcription.problem,
            fix: readiness.transcription.action,
            action: { label: 'Set up', to: '/settings/speech' },
          }
        : hasMic === false
          ? {
              tone: 'warn',
              text: listensTo === 'system' ? 'no microphone — the call is heard, your answers are not' : 'no microphone found',
            }
          : {
              tone: 'ok',
              text: `${heard} · ${engine}`,
              detail:
                listensTo === 'system'
                  ? "The call is heard through your computer's audio output. Questions are taken from the call, never from your microphone."
                  : undefined,
            },
  });

  const lexical = interview && readiness?.retrieval.mode === 'lexical';
  rows.push({
    label: 'AI',
    state: !readiness
      ? { tone: 'warn', text: 'checking…' }
      : !readiness.chat.ready
        ? {
            tone: 'block',
            text: blockedText(readiness.chat.blocked),
            detail: readiness.chat.problem,
            fix: readiness.chat.action,
            action: { label: 'Set up', to: '/settings/models' },
          }
        : readiness.chat.notice
          ? { tone: 'warn', text: `${chatLabel(readiness)} · ${readiness.chat.notice}`, detail: readiness.chat.explanation }
          : {
              // Keyword matching is a limitation, not a blocker: still ready.
              tone: 'ok',
              text: lexical ? `${chatLabel(readiness)} · keyword document matching` : chatLabel(readiness),
              detail: [readiness.chat.explanation, lexical ? readiness.retrieval.note : ''].filter(Boolean).join('\n\n'),
            },
  });
  return rows;
}

export function ReadinessChecklist({ onGo, ...props }: ChecklistProps) {
  // A microphone must exist for the candidate's own words to be heard.
  const [hasMic, setHasMic] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => alive && setHasMic(d.some((x) => x.kind === 'audioinput')))
      .catch(() => alive && setHasMic(null));
    return () => {
      alive = false;
    };
  }, []);

  const rows = checklistRows({ ...props, hasMic });
  return (
    <ul
      className="divide-y divide-white/5 rounded-xl border border-white/5 bg-neutral-900/60 px-3 text-xs"
      data-testid="hears"
      aria-label="Setup"
    >
      {rows.map((r) => (
        <Row key={r.label} label={r.label} onGo={onGo} {...r.state} />
      ))}
    </ul>
  );
}
