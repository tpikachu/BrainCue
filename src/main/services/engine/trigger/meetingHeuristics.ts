/**
 * Deterministic first-pass heuristics for ambient (meeting) turns — step 1 of
 * the trigger architecture. Cheap and pure: no model, no state, no I/O. A
 * `skip` verdict means the salience classifier is NEVER called for the turn
 * (greetings and filler must not cost a model call, let alone a card); a
 * confident verdict skips the classifier too. Only `ambiguous` escalates.
 */

export type HeuristicVerdict =
  | { type: 'skip'; reason: 'too-short' | 'greeting' | 'filler' }
  | { type: 'action_item'; confidence: number; title: string; deadline: string | null }
  | { type: 'decision'; confidence: number; title: string }
  | { type: 'question'; confidence: number; title: string }
  | { type: 'ambiguous' };

const GREETING =
  /^(hi|hey|hello|good\s+(morning|afternoon|evening)|how\s+are\s+you|how'?s\s+it\s+going|can\s+(you\s+guys?|everyone|you)\s+hear\s+me|is\s+everyone\s+(here|on)|welcome|thanks?(\s+you)?(\s+(everyone|all|guys))?|bye|see\s+you|have\s+a\s+(good|great))\b/i;

// Whole-turn filler: acknowledgements that carry no content of their own.
const FILLER =
  /^(um+|uh+|okay|ok|yeah|yep|yes|no|nope|right|sure|cool|got\s+it|sounds\s+good|makes\s+sense|exactly|totally|mm-?hmm?|alright)[.!?\s]*$/i;

const ACTION_INTENT =
  /\b(i'?ll|i\s+will|we'?ll|we\s+will|let'?s|can\s+you|could\s+you|please)\s+\w+/i;
const ACTION_EXPLICIT = /\b(action\s+item|todo|to-do|follow(?:\s|-)?up)\b/i;
const DEADLINE =
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|noon|(the\s+)?end\s+of\s+(the\s+)?(day|week|month|quarter)|next\s+(week|month|monday|tuesday|wednesday|thursday|friday)|\d{1,2}(:\d{2})?\s*(am|pm)?|[a-z]+\s+\d{1,2}(st|nd|rd|th)?)\b/i;

const DECISION =
  /\b(we(?:'ve|\s+have)?\s+(decided|agreed)|the\s+decision\s+is|let'?s\s+go\s+with|we'?re\s+going\s+with|final\s+(call|decision)|it'?s\s+settled)\b/i;

const QUESTION_LEAD =
  /^(who|what|when|where|why|how|which|should|shall|can|could|would|will|do|does|did|are|is|was|were|have|has)\b/i;

const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/** First sentence (or the whole turn if unpunctuated), trimmed for card titles. */
function titleOf(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text.trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

export function evaluateTurnHeuristics(text: string): HeuristicVerdict {
  const t = text.trim();
  if (wordCount(t) < 3) return { type: 'skip', reason: 'too-short' };
  if (FILLER.test(t)) return { type: 'skip', reason: 'filler' };
  // Greetings only skip when the turn is SHORT small talk — "Good morning, we
  // need to finalize the budget" must not be silenced by its greeting lead.
  if (GREETING.test(t) && wordCount(t) <= 8) return { type: 'skip', reason: 'greeting' };

  if (DECISION.test(t)) return { type: 'decision', confidence: 0.85, title: titleOf(t) };

  if (ACTION_EXPLICIT.test(t) || ACTION_INTENT.test(t)) {
    const deadline = t.match(DEADLINE)?.[0] ?? null;
    // Commitment language alone is a weak signal ("let's move on"); an explicit
    // marker or a deadline makes it a confident action item.
    if (ACTION_EXPLICIT.test(t) || deadline) {
      return { type: 'action_item', confidence: deadline ? 0.95 : 0.85, title: titleOf(t), deadline };
    }
  }

  if (/\?\s*$/.test(t) || (QUESTION_LEAD.test(t) && t.includes('?'))) {
    return { type: 'question', confidence: 0.75, title: titleOf(t) };
  }

  return { type: 'ambiguous' };
}

// --- open-question tracking helpers (pure; state lives in the policy) -------

const STOPWORDS = new Set(
  'a an the is are was were do does did what when where who why how which our your their my his her its of for to in on at by with and or so we you they i it this that'.split(
    ' ',
  ),
);

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** Does `reply` plausibly answer `question`? Deliberately conservative rules:
 *  shared content words, a bare yes/no, or an answer-lead with a number. */
export function answersQuestion(reply: string, question: string): boolean {
  const r = reply.trim();
  if (/^(yes|no|yeah|yep|nope)\b/i.test(r) && wordCount(r) <= 4) return true;
  const q = contentWords(question);
  let overlap = 0;
  for (const w of contentWords(r)) if (q.has(w)) overlap += 1;
  if (overlap >= 1) return true;
  return /^(it'?s|that'?s|about|around|roughly)\b/i.test(r) && /\d/.test(r);
}
