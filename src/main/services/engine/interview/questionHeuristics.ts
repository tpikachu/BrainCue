import type { QuestionType } from '@shared/types';

/**
 * Cheap, deterministic reading of one interviewer utterance — the first gate
 * of interview question detection (docs/06-OPENAI-SERVICE.md §Detection).
 *
 * Interviewers rarely speak in grammatical questions. "Tell me about
 * yourself." "Walk me through that project." "Explain the trade-offs." None
 * carries a question mark, and a classifier prompted with "is this a
 * question?" said no to a good share of them. On the other side, "Okay.",
 * "Great, thanks." and "Mm-hmm" are most of what an interviewer says and none
 * of them should cost a model round trip.
 *
 * So this layer only decides the cases it can decide RELIABLY and hands the
 * rest to the model:
 *
 *  - `question`   a clear interrogative or an interview request — answer now,
 *                 no classifier on the latency path
 *  - `not`        pure backchannel / courtesy — never a cue
 *  - `fragment`   the utterance stops mid-thought ("…walk me through the") —
 *                 the transcriber endpointed on a pause; hold it briefly for
 *                 the rest
 *  - `ambiguous`  everything else — the classifier decides, with context
 *
 * It is deliberately small. A rule belongs here only when it is right almost
 * every time it fires; recall on the long tail is the classifier's job.
 */

export type UtteranceVerdict = 'question' | 'not' | 'fragment' | 'ambiguous';

export interface UtteranceAssessment {
  verdict: UtteranceVerdict;
  /** 0..1 — how sure the rule is. Only meaningful for question/not. */
  confidence: number;
  /** Best-effort question type for `question` verdicts (the classifier's
   *  vocabulary), so a heuristic hit still gets the behavioral story shape. */
  type: QuestionType;
  /** Which rule fired, for logs and the eval report. Never contains text. */
  rule: string;
  /** Weak interrogative signal present (wh-start without "?", "and your…")
   *  — the fallback when the classifier is unavailable. */
  leaning: boolean;
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'?\s-]+/gu, ' ')
    .replace(/\?/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Pure acknowledgements. An utterance made ONLY of these is never a cue. */
const BACKCHANNEL = new Set([
  'ok', 'okay', 'k', 'great', 'cool', 'right', 'yeah', 'yes', 'yep', 'yup', 'no', 'nope', 'sure',
  'mm', 'mhm', 'mm-hmm', 'uh-huh', 'hmm', 'hm', 'uh', 'um', 'ah', 'oh', 'wow', 'nice', 'perfect',
  'awesome', 'good', 'excellent', 'interesting', 'gotcha', 'got', 'it', 'thanks', 'thank', 'you',
  'alright', 'all', 'fine', 'makes', 'sense', 'sounds', 'i', 'see', 'understood', 'fair', 'enough',
  'totally', 'absolutely', 'definitely', 'exactly', 'indeed', 'hello', 'hi', 'hey', 'bye', 'so',
  'well', 'and', 'that', "that's", 'is', 'very', 'really', 'super', 'helpful', 'lovely', 'brilliant',
]);

/** Words an utterance cannot end on when the speaker is done. */
const DANGLING = new Set([
  'and', 'or', 'but', 'the', 'a', 'an', 'to', 'of', 'about', 'with', 'your', 'my', 'our', 'for',
  'in', 'on', 'at', 'from', 'into', 'like', 'which', 'whether', 'because', 'if', 'than', 'is',
  'are', 'was', 'were', 'um', 'uh', 'through',
  'between', 'some', 'any',
]);

const WH = new Set(['what', "what's", 'why', 'how', "how's", 'when', 'where', 'which', 'who', "who's", 'whom', 'whose']);

const AUX = new Set([
  'do', 'does', 'did', 'are', 'is', 'was', 'were', 'have', 'has', 'had', 'can', 'could', 'would',
  'will', 'should', 'may', 'might', 'shall', "didn't", "don't", "doesn't", "isn't", "aren't",
  "wasn't", "weren't", "haven't", "hasn't", "can't", "couldn't", "wouldn't", "won't", "shouldn't",
]);
const AUX_SUBJECT = new Set(['you', 'your', 'we', 'they', 'it', 'there', 'that', 'this', 'i', 'he', 'she', 'anyone', 'someone']);

/** Request verbs an interviewer uses in the imperative. */
const REQUEST_VERBS = new Set([
  'tell', 'walk', 'explain', 'describe', 'talk', 'share', 'give', 'take', 'elaborate', 'expand',
  'discuss', 'compare', 'contrast', 'outline', 'summarize', 'summarise', 'introduce', 'define',
  'design', 'implement', 'write', 'sketch', 'list', 'name', 'clarify', 'justify', 'estimate',
  'go', 'run', 'show', 'help', 'convince', 'pitch', 'teach', 'break', 'unpack', 'reflect',
]);

/** Leading words that soften or chain a request without changing it. */
const SOFTENERS = new Set([
  'so', 'okay', 'ok', 'alright', 'right', 'now', 'great', 'cool', 'and', 'then', 'next', 'also',
  'well', 'perfect', 'awesome', 'nice', 'good', 'thanks', 'thank', 'you', 'please', 'maybe',
  'first', 'firstly', 'finally', 'lastly', 'just', 'quickly', 'briefly', 'um', 'uh', 'yeah',
]);

const REQUEST_PHRASES: RegExp[] = [
  /\b(could|can|would|will) you (please )?(tell|walk|explain|describe|talk|share|give|take|elaborate|expand|discuss|compare|outline|summari[sz]e|introduce|define|design|implement|write|sketch|list|clarify|go|run|show|help)\b/,
  /\bi'?d (like|love|want) (you )?to (hear|know|understand|learn|get|see)\b/,
  /\bi (want|would like) (you )?to (hear|know|understand|learn)\b/,
  /\bi'?m (curious|interested|wondering) (about|how|why|what|whether|if|to)\b/,
  /\bhelp me understand\b/,
  /\blet'?s (talk|dive|dig|go|get|start|move|turn|switch|focus|discuss|look|spend)\b.{0,40}\b(about|into|on|to|with|at|through)\b/,
  /\b(any|got any) (questions?|thoughts?) (for|about|on)\b/,
  /^(so |and |okay |ok )?(any |your )?(thoughts|take|views?|opinions?|perspective|feelings) (on|about)\b/,
  /\bwhat (about|if)\b/,
  /\bhow (about|come)\b/,
];

const LOGISTICS =
  /\b((can|could|do) you (hear|see) (me|my|us|that|it)|is my (audio|mic|screen|video|camera)|am i (on mute|muted|breaking up|audible)|are you (on mute|muted|still there|there)|you'?re (on mute|muted|breaking up)|(let me|i'll|i will|shall i) (share|stop sharing|pull up|bring up)|can you see my screen|is (the|my) screen (visible|showing|coming through)|(one|a) (sec|second|moment|minute)|bear with me|let me (just )?(check|grab|find|open))\b/;

/** Rhetorical idioms: interrogative in form, never a request for an answer. */
const RHETORICAL =
  /^(who knows|who would have thought|isn'?t (that|it) (always|just) (the way|how it goes)|go figure|what can you do|you know what i mean|guess what|why not|how about that)\b/;

/** Leading phrases that mark the utterance as a reply to the CANDIDATE, not a
 *  new request ("That's great, thanks for sharing."). */
const COURTESY = /^(that'?s|that is|this is|it'?s|sounds|thanks|thank you|great|awesome|perfect|okay|ok|nice|cool|lovely|brilliant|excellent)\b[^?]*$/;

function guessType(lower: string, nWords: number): QuestionType {
  if (/\b(salary|compensation|pay range|notice period|start date|availability|relocat|visa|sponsorship)\b/.test(lower))
    return 'salary_availability';
  if (/\b(write (a|the|some) (function|code|program|query)|implement|algorithm|time complexity|big[- ]o|leetcode|reverse a|linked list|binary tree|array of)\b/.test(lower))
    return 'coding';
  if (/\b(design (a|an|the)|system design|architect|scale (it|this|to)|high[- ]level design|how would you build)\b/.test(lower))
    return 'system_design';
  if (/\b(tell me about a time|describe a (time|situation)|give me an example|have you ever|how did you (handle|deal|manage|resolve)|conflict|disagree|mistake|failure|failed|difficult|challenge|proud|pushback|stakeholder)\b/.test(lower))
    return 'behavioral';
  if (/\b(yourself|your background|your experience|your resume|your cv|your current role|your role|your team|walk me through (your|the|that|this) (resume|background|career|project)|that project|this project|the project|previous (role|job|company))\b/.test(lower))
    return 'resume_project';
  if (/\b(product|users?|customer|metric|roadmap|prioriti[sz]e|feature)\b/.test(lower)) return 'product';
  if (nWords <= 6) return 'followup';
  return 'technical_concept';
}

function stripSofteners(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length - 1 && SOFTENERS.has(ws[i])) i++;
  return ws.slice(i);
}

export function assessUtterance(text: string): UtteranceAssessment {
  const raw = text.trim();
  const lower = raw.toLowerCase().replace(/[’‘]/g, "'");
  const ws = words(raw);
  const n = ws.length;
  const endsQ = /\?\s*["')\]]*$/.test(raw);
  const anyQ = raw.includes('?');
  const endsTerminal = /[.!?…]\s*["')\]]*$/.test(raw);
  const base = (verdict: UtteranceVerdict, confidence: number, rule: string, leaning = false): UtteranceAssessment => ({
    verdict,
    confidence,
    rule,
    leaning,
    type: guessType(lower, n),
  });

  if (n === 0) return base('not', 1, 'empty');

  // Pure backchannel — "Okay.", "Great, thanks!", "Mm-hmm, that makes sense."
  if (!anyQ && n <= 6 && ws.every((w) => BACKCHANNEL.has(w))) return base('not', 0.97, 'backchannel');
  // "Hmm?", "Right?", "Okay?" — a tag or a check-in, not reliably a request.
  // The model decides with the turn before it.
  if (anyQ && n <= 2 && ws.every((w) => BACKCHANNEL.has(w))) return base('ambiguous', 0.4, 'backchannel-tag');

  // Stops mid-thought: the endpoint fired on a pause. Only without terminal
  // punctuation — the transcriber puts a period on a finished sentence.
  const last = ws[n - 1];
  if (!endsTerminal && (DANGLING.has(last) || /(\.\.\.|…|,|-)\s*$/.test(raw)) && n >= 2) {
    return base('fragment', 0.8, 'dangling-end', WH.has(ws[0]) || REQUEST_VERBS.has(stripSofteners(ws)[0]));
  }
  if (/(\.\.\.|…)\s*$/.test(raw)) return base('fragment', 0.7, 'trailing-ellipsis');

  // Call logistics — "Can you hear me?", "Is my screen showing?" — are
  // questions, but a cue card for them is noise: the candidate just says yes.
  if (LOGISTICS.test(lower)) return base('not', 0.9, 'logistics');
  if (RHETORICAL.test(lower.replace(/^(well|so|and|i mean|but),?\s+/, ''))) return base('not', 0.85, 'rhetorical');

  const core = stripSofteners(ws);
  const head = core[0];
  const second = core[1];

  // A clear interrogative: a question mark at the end of the utterance.
  // ("Is that right?" after the candidate's answer is still something to
  // answer — the candidate is asked to confirm.)
  if (endsQ) return base('question', 0.95, 'question-mark');

  // "Tell me about yourself." / "Walk me through that project." / "Explain
  // the trade-offs." — an imperative request verb leading the utterance.
  if (REQUEST_VERBS.has(head) && core.length >= 2) {
    // "Go on" / "take your time" / "give me a second" are not requests for an
    // answer; neither is "let me…" (the interviewer talking about themself).
    if (/^(go on|go ahead|take (your|a) (time|moment|second)|give me a (sec|second|moment|minute)|show me later|help yourself)\b/.test(core.join(' ')))
      return base('not', 0.85, 'stall-phrase');
    return base('question', 0.9, 'imperative-request');
  }

  if (REQUEST_PHRASES.some((re) => re.test(lower))) return base('question', 0.85, 'request-phrase');

  // Wh-word or inverted auxiliary at the head, with or without punctuation —
  // transcribers often drop the "?" on a falling-intonation question.
  if (head && WH.has(head)) {
    // "What I'd say is…", "How we do it here is…" — a wh-clause as subject.
    if (!anyQ && /^(what|how|where|when|why) (i|we|they|you|he|she|people)\b(\s+\S+){0,6}?\s+(is|was|are|were|means)\b/.test(core.join(' ')))
      return base('ambiguous', 0.4, 'wh-clause-subject', false);
    return base('question', n <= 3 ? 0.75 : 0.85, 'wh-start');
  }
  if (head && AUX.has(head) && second && AUX_SUBJECT.has(second)) return base('question', 0.85, 'aux-inversion');

  // A preamble, then the ask: "Thanks for joining. To start, tell me about
  // yourself." Nothing above decided the WHOLE turn (its head is "thanks"),
  // so a later sentence — or the clause after a leading "To start," — that is
  // clearly a request decides it. (Live run 2026-11-17: the courtesy rule
  // below dropped exactly this opener.)
  const later = laterAsk(raw);
  if (later) return { ...later, rule: `later-sentence/${later.rule}`, type: later.type };

  // Courtesy reply with no ask in it.
  if (!anyQ && COURTESY.test(lower) && n <= 14) return base('not', 0.8, 'courtesy');

  // Short elliptical follow-ups without a "?" ("And your role", "The
  // timeline") — lean question, let the model decide with context.
  const leaning = n <= 6 && (/^(and|so|but|or|also) /.test(lower) || /\byour\b/.test(lower));
  return base('ambiguous', 0.5, 'no-rule', leaning);
}

/** A sentence after the first (or the clause after a short leading phrase
 *  like "To start,") that the rules read as a clear request. */
function laterAsk(raw: string): UtteranceAssessment | null {
  const parts = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const pieces: string[] = parts.slice(1);
  for (const p of parts) {
    const m = /^([^,]{1,24}),\s+(.+)$/.exec(p); // "To start, tell me…" / "So, walk me…"
    if (m && words(m[1]).length <= 4) pieces.push(m[2]);
  }
  for (const p of pieces) {
    if (p === raw) continue;
    const a = assessUtterance(p);
    if (a.verdict === 'question' && a.confidence >= 0.85) return a;
  }
  return null;
}

/** "Sorry, I meant…", "Actually, let me rephrase" — the utterance replaces the
 *  previous question rather than adding to it. Never call logistics or a
 *  backchannel: "Sorry, can you hear me okay?" is not a revised question
 *  (live run 2026-11-17 merged exactly that into the question before it). */
export function isCorrection(text: string): boolean {
  if (assessUtterance(text).verdict === 'not') return false;
  return /^(sorry|actually|no,? wait|wait|let me rephrase|i mean|i meant|rather|or rather|scratch that|correction|what i meant)\b/i.test(
    text.trim().replace(/^[,.\s]+/, ''),
  );
}

/** "…and also how you tested it." / "Or the second one." — the utterance
 *  continues the previous question (a split or multi-part question). */
export function isContinuation(text: string): boolean {
  const t = text.trim();
  if (assessUtterance(t).verdict === 'not') return false; // logistics / backchannel never extend a question
  const m = /^(and|or|also|plus|specifically|particularly|especially|including|as well as|along with|in particular|like,|for example)\b[,\s]*(.*)$/i.exec(t);
  const lowerStart = /^[a-z]/.test(t) && !/^(i|i'm|i've|i'd)\b/.test(t); // a lower-case start resumes a sentence…
  if (!m && !lowerStart) return false;
  // …unless what follows is a complete question of its own — an inverted
  // interrogative: "And why are you interested in this role?" — not the
  // second half of the last one, unlike "…and what you would do differently"
  // or "and how you tested it". Checked whatever the capitalisation: the
  // transcriber often lower-cases a new turn (M3 review).
  const rest = words(m ? m[2] : t);
  const inverted =
    rest.length >= 4 &&
    ((WH.has(rest[0]) && AUX.has(rest[1]) && AUX_SUBJECT.has(rest[2])) || (AUX.has(rest[0]) && AUX_SUBJECT.has(rest[1])));
  return !inverted;
}
