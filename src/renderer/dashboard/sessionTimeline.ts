import { normalizeSpeaker, type SessionDetail, type SessionMode } from '@shared/types';

/**
 * A saved session as one readable timeline — built ONLY from what was
 * persisted (transcript, detected questions with their generated answers,
 * other cards), so history opens with no API key, no report and no network.
 *
 * - Turns keep their CAPTURE order (the order `sessions.detail` returns, the
 *   M4 transcript order) — never re-sorted by a clock.
 * - What a person SAID and what BrainCue GENERATED are different item kinds,
 *   so the view can never present a suggestion as something said.
 * - A suggestion sits right after the turn its question was detected on; one
 *   with no such turn (a typed Ask, a v1 row), and every other card, sits
 *   after the last turn captured before it.
 * - A saved answer card (a voice quick Ask: no detected question, no
 *   transcript) is a suggestion too — its title is what was asked. One written
 *   for a detected question fills that question's answer if the answer row is
 *   missing, and is never shown twice.
 */

export type Who = ReturnType<typeof normalizeSpeaker>;

export type TimelineItem =
  | { kind: 'turn'; id: string; who: Who; label: string; text: string }
  | {
      kind: 'suggestion';
      id: string;
      question: string;
      /** The generated answer ('' or null: never answered). */
      answer: string | null;
      /** Why it was not answered, or a caution shown with it. */
      note: string | null;
      /** Asked by the user directly (a saved quick Ask), not detected in
       *  what was said. */
      asked?: boolean;
    }
  | { kind: 'card'; id: string; cardKind: string; title: string | null; body: string };

/** Who a speaker is, in this activity's words. */
export function speakerLabel(speaker: string, mode: SessionMode | null | undefined): { who: Who; label: string } {
  const who = normalizeSpeaker(speaker);
  const interviewish = mode === 'interview' || mode === 'practice';
  const label =
    who === 'them' ? (interviewish ? 'Interviewer' : 'Them') : who === 'you' ? 'You' : who === 'agent' ? 'Practice interviewer' : 'Speaker';
  return { who, label };
}

export function sessionTimeline(d: Pick<SessionDetail, 'transcript' | 'questions' | 'cards' | 'mode'>): TimelineItem[] {
  const turns = d.transcript.filter((t) => t.text.trim());
  const at = new Map(turns.map((t, i) => [t.id, i]));
  // after[i + 1] = what follows turn i; after[0] = before the first turn.
  const after: { t: number; item: TimelineItem }[][] = Array.from({ length: turns.length + 1 }, () => []);
  /** The slot after the last turn captured at or before `time`. */
  const slotFor = (time: number) => {
    let slot = 0;
    turns.forEach((t, i) => {
      if (t.createdAt <= time) slot = i + 1;
    });
    return slot;
  };

  // Answer cards written for a detected question (by id) — the question's
  // own row is the one shown; the card only fills a missing answer.
  const questionIds = new Set(d.questions.map((q) => q.id));
  const linkedBody = new Map<string, string>();
  const cards = (d.cards ?? []).filter((c) => {
    const qid = c.kind === 'answer' ? linkedQuestionId(c.meta) : null;
    if (qid && questionIds.has(qid)) {
      if (c.body.trim()) linkedBody.set(qid, c.body);
      return false;
    }
    return true;
  });

  for (const q of d.questions) {
    const anchored = q.transcriptChunkId != null ? at.get(q.transcriptChunkId) : undefined;
    const slot = anchored !== undefined ? anchored + 1 : slotFor(q.createdAt);
    const answer = q.answer?.directAnswer?.trim() ? q.answer.directAnswer : (linkedBody.get(q.id) ?? null);
    after[slot].push({
      t: q.createdAt,
      item: { kind: 'suggestion', id: q.id, question: q.text, answer, note: q.answer?.riskWarning ?? null },
    });
  }
  for (const c of cards) {
    if (!c.body.trim() && !c.title) continue;
    after[slotFor(c.createdAt)].push({
      t: c.createdAt,
      item:
        c.kind === 'answer'
          ? { kind: 'suggestion', id: c.id, question: c.title?.trim() || 'Asked', answer: c.body.trim() ? c.body : null, note: null, asked: true }
          : { kind: 'card', id: c.id, cardKind: c.kind, title: c.title, body: c.body },
    });
  }

  const out: TimelineItem[] = [];
  const flush = (slot: number) => {
    for (const x of after[slot].sort((a, b) => a.t - b.t)) out.push(x.item);
  };
  flush(0);
  turns.forEach((t, i) => {
    const { who, label } = speakerLabel(t.speaker, d.mode);
    out.push({ kind: 'turn', id: t.id, who, label, text: t.text });
    flush(i + 1);
  });
  return out;
}

function linkedQuestionId(meta: Record<string, unknown> | null | undefined): string | null {
  return meta && typeof meta.questionId === 'string' ? meta.questionId : null;
}
