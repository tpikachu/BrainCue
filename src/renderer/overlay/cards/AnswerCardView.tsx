import { Markdown } from '../../components/Markdown';
import { injectPronunciations, splitPronunciation } from '../pronunciation';
import { Citations, StoryCue } from './annotations';
import type { CardViewProps } from './registry';

/** The displayed answer body: the model's structured [[PRONUNCIATION]] section is
 *  stripped and each hard word's respelling is injected inline right after the word
 *  — "regulations (reg-yuh-LAY-shunz)" — so the cue sits in context. The underlying
 *  answer (copy/persist) stays clean. */
function renderAnswerBody(answer: string): string {
  const { body, entries } = splitPronunciation(answer);
  return entries.length ? injectPronunciations(body, entries) : body;
}

/** The v1 answer card body, unchanged: streamed markdown with inline
 *  pronunciation cues, the predicted follow-up, the Story-to-tell cue, and
 *  [n]-citation chips. Also renders `code` contributions (a coding solve is the
 *  same streamed markdown; only its actions differ — see the registry). */
export function AnswerCardView({ card, isCurrent, live, paused, openCite, onToggleCite }: CardViewProps) {
  return (
    <div className="mt-0.5 leading-relaxed">
      {card.body ? (
        <Markdown>{renderAnswerBody(card.body)}</Markdown>
      ) : isCurrent && live && !paused ? (
        <span className="text-xs text-neutral-500">Listening…</span>
      ) : null}
      {card.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
      {!card.streaming && card.followup && (
        <p className="mt-1.5 rounded border-l-2 border-indigo-500/60 bg-indigo-500/5 px-2 py-1 text-[11px] text-indigo-200/90">
          <span className="font-medium text-indigo-300">Likely follow-up:</span> {card.followup}
        </p>
      )}
      <StoryCue card={card} />
      <Citations card={card} openKey={openCite} onToggle={onToggleCite} />
    </div>
  );
}
