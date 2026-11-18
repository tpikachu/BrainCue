import { bm25 } from '../../rag/lexical';
import { assessUtterance } from './questionHeuristics';

/**
 * In-session continuity for live answers (docs/16-CONTINUITY.md §Live).
 *
 * v1 handed the answer prompt a 10-item buffer, each item clipped to 300
 * characters, where an "asked" item held the question and BrainCue's own
 * suggested answer. Three things went wrong with that:
 *
 *  - after ten exchanges anything the candidate said earlier was gone;
 *  - the suggestion was presented next to the question as "You answered:",
 *    so the model treated what BrainCue SUGGESTED as what the candidate SAID —
 *    and a short follow-up retrieved on that suggestion's wording, which may
 *    name a project the candidate never mentioned;
 *  - every short question was attached to the previous topic, even "And what
 *    about Kubernetes?" — a topic switch.
 *
 * This keeps the whole session's turns (bounded) and renders a SNAPSHOT per
 * answer, with every source kept distinct:
 *
 *   recent      the last turns verbatim, speaker-labelled
 *   earlier     one compact line per earlier exchange — the interviewer's
 *               question and what the candidate actually said, each tagged
 *               with its turn number so it is traceable to the transcript
 *   recalled    older turns retrieved (BM25) because THIS question needs them
 *   suggestions BrainCue's own earlier leads, labelled as NOT evidence
 *   subject     for a referential follow-up: the exchange it continues
 *
 * No model call, no summarisation pass: deterministic and bounded, so it
 * costs nothing on the answer's hot path and can never invent a fact.
 */

export type TurnRole = 'interviewer' | 'candidate';

export interface Turn {
  /** Monotonic turn number within the session — the trace handle. */
  n: number;
  role: TurnRole;
  text: string;
  at: number;
}

export interface Suggestion {
  questionId: string;
  question: string;
  /** The first sentence/line of the suggested answer (the "lead"). */
  lead: string;
  at: number;
}

export interface Exchange {
  /** Turn number of the interviewer's question. */
  n: number;
  /** When the question was asked. */
  at: number;
  question: string;
  /** What the candidate actually said in reply (empty: no reply captured). */
  said: string;
}

export interface ConversationSnapshot {
  recent: Turn[];
  earlier: Exchange[];
  recalled: Turn[];
  suggestions: Suggestion[];
  /** Set when the question reads as a follow-up to the last exchange. */
  subject: Exchange | null;
  /** Earlier interviewer questions the candidate has not replied to. */
  open: Exchange[];
}

/** Budgets — sized for the prompt. Every block is bounded on its own so a
 *  long interview never grows the prompt. */
export const LIMITS = {
  maxTurns: 3000,
  recentTurns: 12,
  recentChars: 2400,
  turnChars: 600,
  earlierExchanges: 12,
  earlierQuestionChars: 160,
  earlierSaidChars: 220,
  recalledTurns: 3,
  recalledChars: 400,
  suggestions: 3,
  suggestionChars: 180,
  subjectSaidChars: 240,
  referentialMaxWords: 10,
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

const TOPIC_SHIFT =
  /\b(let'?s (move on|switch|change|talk about something|turn to|go to)|moving on|switch(ing)? gears|different (topic|question|area)|next (question|topic)|on another note|changing (the )?topic|new topic)\b/i;
const ANAPHOR =
  /\b(there|that|this|it|its|those|these|them|they|then|such|same|the (team|project|company|role|system|migration|launch|decision|approach|one))\b|^(and|so|but|or|also|what about|how about|why|how come|meaning|in what way|for example|such as)\b/i;

/** The first line or sentence of an answer — enough to name its subject. */
export function leadOf(answer: string): string {
  const firstLine = (answer.trim().split(/\n+/)[0] ?? '').replace(/\*\*/g, '');
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return sentence.replace(/\s*(\[\d+\]|\[M\d+\])/g, '').trim();
}

/** Capitalised words that are not sentence-initial — a rough named-entity
 *  probe for "did this follow-up name something new?". */
function names(text: string): Set<string> {
  const out = new Set<string>();
  const ws = text.split(/\s+/);
  ws.forEach((w, i) => {
    const clean = w.replace(/[^\p{L}\p{N}.+#-]/gu, '');
    if (i === 0 || !/^\p{Lu}/u.test(clean) || clean === 'I') return;
    out.add(clean.toLowerCase());
  });
  return out;
}

export class ConversationContext {
  private readonly turns: Turn[] = [];
  private readonly suggestions: Suggestion[] = [];
  private nextN = 1;

  /** Record one finalized turn, at the time it was SPOKEN. The candidate's
   *  own turns are committed late (the echo guard holds them ~1.5 s), so a
   *  turn can arrive after a later one — it is placed by `at`, so a reply is
   *  never attributed to the question asked after it. Returns its number. */
  addTurn(role: TurnRole, text: string, at = Date.now()): number {
    const t = text.trim();
    if (!t) return 0;
    const turn = { n: this.nextN++, role, text: clip(t, LIMITS.turnChars), at };
    let i = this.turns.length;
    while (i > 0 && this.turns[i - 1].at > at) i--;
    this.turns.splice(i, 0, turn);
    if (this.turns.length > LIMITS.maxTurns) this.turns.splice(0, this.turns.length - LIMITS.maxTurns);
    return turn.n;
  }

  /** Record (or, for a regenerate, replace) BrainCue's suggestion for a question. */
  addSuggestion(questionId: string, question: string, answer: string, at = Date.now()): void {
    const lead = clip(leadOf(answer), LIMITS.suggestionChars);
    if (!lead) return;
    const existing = this.suggestions.find((s) => s.questionId === questionId);
    if (existing) {
      existing.question = question;
      existing.lead = lead;
      existing.at = at;
      return;
    }
    this.suggestions.push({ questionId, question, lead, at });
    if (this.suggestions.length > 200) this.suggestions.shift();
  }

  get size(): number {
    return this.turns.length;
  }

  /** The last few turns, for the question classifier. Only what was SAID. */
  recentForClassifier(n = 4): { speaker: TurnRole; text: string }[] {
    return this.turns.slice(-n).map((t) => ({ speaker: t.role, text: t.text }));
  }

  /** Interviewer questions with what the candidate said after each, in order.
   *  A question is an interviewer turn the rules read as one, or one
   *  BrainCue answered. */
  exchanges(): Exchange[] {
    const answered = new Set(this.suggestions.map((s) => s.question));
    const out: Exchange[] = [];
    let cur: { n: number; at: number; question: string; said: string[] } | null = null;
    const flush = () => cur && out.push({ n: cur.n, at: cur.at, question: cur.question, said: cur.said.join(' ') });
    for (const t of this.turns) {
      if (t.role === 'interviewer') {
        // A question the scheduler joined (split question) is answered under
        // its joined text — any interviewer turn that ends that text counts.
        const isQ =
          answered.has(t.text) ||
          [...answered].some((a) => a.endsWith(t.text)) ||
          assessUtterance(t.text).verdict === 'question';
        if (isQ) {
          flush();
          cur = { n: t.n, at: t.at, question: t.text, said: [] };
        }
      } else if (cur) {
        cur.said.push(t.text);
      }
    }
    flush();
    return out;
  }

  /** Is this question a follow-up to the last exchange (so it inherits its
   *  subject), rather than a new or switched topic? */
  isReferential(question: string, last: Exchange | null): boolean {
    if (!last) return false;
    const ws = question.trim().split(/\s+/);
    if (ws.length > LIMITS.referentialMaxWords) return false;
    if (TOPIC_SHIFT.test(question)) return false;
    // Names something the last exchange did not → a new subject.
    const known = names(`${last.question} ${last.said}`);
    for (const n of names(question)) if (!known.has(n)) return false;
    return ANAPHOR.test(question) || ws.length <= 4;
  }

  /** The exchange a question would continue: the most recent one that is
   *  not the question itself. */
  private lastExchangeBefore(question: string): Exchange | null {
    const ex = this.exchanges();
    const q = question.trim();
    for (let i = ex.length - 1; i >= 0; i--) if (ex[i].question !== q && !q.endsWith(ex[i].question)) return ex[i];
    return null;
  }

  /**
   * The text retrieval should use. A referential follow-up carries the
   * subject with it — from the interviewer's previous question and what the
   * candidate ACTUALLY SAID, not BrainCue's suggestion (which may name a
   * project the candidate never mentioned). Only when no candidate speech
   * was captured at all (no mic stream) does the suggestion's lead stand in,
   * as the best available signal of what was discussed.
   */
  retrievalQuery(question: string): string {
    const last = this.lastExchangeBefore(question);
    if (!last || !this.isReferential(question, last)) return question;
    const said = clip(last.said, LIMITS.subjectSaidChars);
    if (said) return `${last.question} ${said} ${question}`;
    const sug = [...this.suggestions].reverse().find((s) => s.question === last.question);
    return sug ? `${last.question} ${clip(sug.lead, 160)} ${question}` : `${last.question} ${question}`;
  }

  /**
   * A coherent, bounded snapshot for one answer. Taken synchronously at the
   * start of generation and copied, so turns that arrive while the answer
   * streams can never change (or tear) the context it was built on.
   */
  snapshot(question: string): ConversationSnapshot {
    const q = question.trim();
    // Recent window, newest first until the budget runs out; the current
    // question's own turn(s) are the QUESTION, not context.
    const recent: Turn[] = [];
    let chars = 0;
    for (let i = this.turns.length - 1; i >= 0 && recent.length < LIMITS.recentTurns; i--) {
      const t = this.turns[i];
      if (t.role === 'interviewer' && (t.text === q || q.endsWith(t.text))) continue;
      if (chars + t.text.length > LIMITS.recentChars && recent.length > 0) break;
      chars += t.text.length;
      recent.unshift({ ...t });
    }
    const oldestRecentAt = recent[0]?.at ?? Number.POSITIVE_INFINITY;

    const all = this.exchanges().filter((e) => e.question !== q && !q.endsWith(e.question));
    const earlier = all
      .filter((e) => e.at < oldestRecentAt)
      .slice(-LIMITS.earlierExchanges)
      .map((e) => ({
        n: e.n,
        at: e.at,
        question: clip(e.question, LIMITS.earlierQuestionChars),
        said: clip(e.said, LIMITS.earlierSaidChars),
      }));

    const last = all[all.length - 1] ?? null;
    const subject = last && this.isReferential(q, last) ? { ...last, said: clip(last.said, LIMITS.subjectSaidChars) } : null;

    // Older turns this question needs (the recent window already has the rest).
    const older = this.turns.filter((t) => t.at < oldestRecentAt);
    const recalled = bm25(subject ? `${subject.question} ${q}` : q, older, (t) => t.text, LIMITS.recalledTurns)
      .map((s) => ({ ...s.item, text: clip(s.item.text, LIMITS.recalledChars) }))
      .sort((a, b) => a.at - b.at);

    const suggestions = this.suggestions
      .filter((s) => s.question !== q)
      .slice(-LIMITS.suggestions)
      .map((s) => ({ ...s }));

    // Open questions: earlier interviewer questions with no reply captured,
    // outside the recent window (inside it, the model sees them verbatim).
    const open = all
      .filter((e) => e.at < oldestRecentAt && !e.said)
      .slice(-3)
      .map((e) => ({ ...e, question: clip(e.question, LIMITS.earlierQuestionChars) }));

    return { recent, earlier: earlier.filter((e) => e.said), recalled, suggestions, subject, open };
  }

  /** Restore a resumed session from its persisted rows (oldest first). */
  hydrate(rows: { role: TurnRole; text: string; at: number }[], answers: { questionId: string; question: string; answer: string; at: number }[]): void {
    for (const r of rows) this.addTurn(r.role, r.text, r.at);
    for (const a of answers) this.addSuggestion(a.questionId, a.question, a.answer, a.at);
  }
}
