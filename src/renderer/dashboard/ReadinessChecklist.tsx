import { useEffect, useState } from 'react';
import type { Job, Profile, Readiness } from '@shared/types';

/**
 * Everything an interview needs, checked in one place before Start
 * (docs/11-UX-NAVIGATION.md §Start). Each row says what is set, or exactly
 * what is missing and where to fix it — the user never discovers mid-call
 * that the résumé was never parsed or the call audio was never heard.
 *
 * Rows that cannot be checked before Start say so honestly: the call's audio
 * is chosen in the system picker on Start, and the Cue Card reports if it
 * did not arrive.
 */
export interface ChecklistProps {
  profile: Profile | undefined;
  space: Job | undefined;
  /** Interview-shaped rows (résumé, JD) — only for activities that use them. */
  interview: boolean;
  listensTo: 'system' | 'mic';
  readiness: Readiness | null;
  onGo: (path: string) => void;
}

type Tone = 'ok' | 'warn' | 'block';

function Row(props: { tone: Tone; label: string; children: React.ReactNode; action?: { label: string; to: string }; onGo: (p: string) => void }) {
  const mark = props.tone === 'ok' ? '✓' : props.tone === 'warn' ? '!' : '✕';
  const color = props.tone === 'ok' ? 'text-green-400' : props.tone === 'warn' ? 'text-amber-400' : 'text-red-400';
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className={`mt-px w-3 shrink-0 text-center font-semibold ${color}`} aria-hidden>
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-neutral-200">{props.label}</span>{' '}
        <span className="text-neutral-400">{props.children}</span>
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

export function ReadinessChecklist({ profile, space, interview, listensTo, readiness, onGo }: ChecklistProps) {
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

  const resume: { tone: Tone; text: string } = !profile
    ? { tone: 'block', text: 'no profile selected' }
    : profile.parsedResume
      ? { tone: 'ok', text: `${profile.name} · résumé ready` }
      : profile.resumeText?.trim()
        ? { tone: 'block', text: `${profile.name} · résumé saved but not read yet — save it again once an AI key is set` }
        : { tone: 'block', text: `${profile.name} · no résumé — answers would have nothing of yours to draw on` };

  const jd: { tone: Tone; text: string } = !space
    ? { tone: 'block', text: 'choose the interview this is for' }
    : space.parsedJd || space.jdText?.trim()
      ? { tone: 'ok', text: `${space.title || 'Untitled'}${space.company ? ` · ${space.company}` : ''} · JD ready` }
      : { tone: 'warn', text: `${space.title || 'Untitled'} · no job description — answers won't know what the role asks for` };

  return (
    <ul className="divide-y divide-white/5 rounded-xl border border-white/5 bg-neutral-900/60 px-3 text-xs" data-testid="hears">
      {interview && (
        <Row
          tone={resume.tone}
          label="Candidate"
          onGo={onGo}
          action={profile && resume.tone !== 'ok' ? { label: 'Add résumé', to: `/profiles/${profile.id}` } : undefined}
        >
          {resume.text}
        </Row>
      )}
      {interview && (
        <Row
          tone={jd.tone}
          label="Interview"
          onGo={onGo}
          action={space && jd.tone !== 'ok' ? { label: 'Add JD', to: '/library' } : undefined}
        >
          {jd.text}
        </Row>
      )}
      <Row
        tone={hasMic === false ? 'warn' : 'ok'}
        label="Audio"
        onGo={onGo}
      >
        {listensTo === 'system'
          ? hasMic === false
            ? 'no microphone found — the call is still heard, but your own answers will not be'
            : 'the call (you pick the window or screen to share on Start) and your microphone'
          : hasMic === false
            ? 'no microphone found'
            : 'your microphone'}
      </Row>
      <Row
        tone={!readiness ? 'warn' : readiness.chat.ready ? (readiness.chat.notice ? 'warn' : 'ok') : 'block'}
        label="AI"
        onGo={onGo}
        action={readiness && !readiness.chat.ready ? { label: 'Set up', to: '/settings/models' } : undefined}
      >
        {!readiness ? 'checking…' : readiness.chat.ready ? (readiness.chat.notice ?? readiness.chat.explanation) : `${readiness.chat.problem} ${readiness.chat.action ?? ''}`}
      </Row>
      <Row
        tone={!readiness ? 'warn' : readiness.transcription.ready ? 'ok' : 'block'}
        label="Transcription"
        onGo={onGo}
        action={readiness && !readiness.transcription.ready ? { label: 'Set up', to: '/settings/speech' } : undefined}
      >
        {!readiness
          ? 'checking…'
          : readiness.transcription.ready
            ? readiness.transcription.engine === 'local'
              ? 'on this device — audio never leaves it'
              : 'OpenAI Realtime'
            : `${readiness.transcription.problem} ${readiness.transcription.action ?? ''}`}
      </Row>
      {readiness?.retrieval.mode === 'lexical' && interview && (
        <Row tone="warn" label="Documents" onGo={onGo}>
          matched by keyword (no OpenAI key for semantic search) — still used, may miss reworded passages
        </Row>
      )}
    </ul>
  );
}
