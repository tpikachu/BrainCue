import { providerFor } from '../../providers/registry';
import { normalizeSpeaker } from '@shared/types';
import type {
  AnswerFormat,
  InterviewType,
  Profile,
  RetrievedChunk,
  RetrievedMemory,
  Speaker,
} from '@shared/types';

/**
 * WHO the answer is being written for.
 *
 * `interview` casts the model as the candidate being assessed — the v1 framing,
 * and still exactly right when someone is in an interview. It is badly wrong
 * anywhere else: it tells the model an interviewer is watching and that the
 * user's job is to prove themselves, so a summoned answer in a standup came out
 * as a pitch. `conversation` is the framing for every other mode.
 */
export type AnswerFraming = 'interview' | 'conversation';

/**
 * What has already happened in THIS live session, oldest first: turns the
 * app heard, and questions it already answered. Threaded into the answer
 * prompt so question N can resolve "that", "the second one", "what about the
 * timeline?" against question N-1 — every answer used to be a cold start.
 * The engine owns the buffer (size, clipping); this layer only renders it.
 */
export type SessionHistoryItem =
  /** A finalized turn. `speaker` says whose: the remote side ("Heard:") or
   *  the user's own microphone ("You said:"). Absent = remote (v1 shape). */
  | { role: 'heard'; text: string; speaker?: Speaker }
  | { role: 'asked'; question: string; answer: string };
export type SessionHistory = SessionHistoryItem[];

export interface AnswerInput {
  question: string;
  contextChunks: RetrievedChunk[];
  /** Approved memories recalled for this question. Absent/empty leaves the
   *  prompt byte-identical to v1 — memory only ever ADDS a section. */
  memories?: RetrievedMemory[];
  profile: Profile;
  /** The single answer control (v1.2): key_points | explanation | detailed. */
  format: AnswerFormat;
  /** Annotate rare/technical/foreign terms with a quick phonetic respelling. */
  pronunciation: boolean;
  /** Defaults to `interview` so the v1 path is unchanged byte-for-byte. */
  framing?: AnswerFraming;
  /** Only meaningful under `interview` framing; ignored otherwise. */
  interviewType?: InterviewType;
  /** Earlier turns + answered questions of this session. Absent/empty leaves
   *  the prompt byte-identical — history only ever ADDS a section. */
  history?: SessionHistory;
  signal?: AbortSignal;
}

/** Human-readable instruction per answer FORMAT, injected into the prompt.
 *  explanation/story_teller are read ALOUD verbatim mid-interview, so their
 *  instructions optimize for speakability: first-read fluency, breath-sized
 *  paragraphs, linear structure. */
const FORMAT_INSTRUCTION: Record<AnswerFormat, string> = {
  key_points:
    'FORMAT = KEY POINTS (STRICT). A glanceable cue to speak FROM, not a full answer. ' +
    'Hard cap: ~60 words TOTAL. One short opening line (≤12 words) I can say verbatim, then ' +
    '2–3 terse bullets of a few words each — keywords to riff on, not sentences. ' +
    'No paragraphs, no preamble. Shorter is better.',
  explanation:
    'FORMAT = EXPLANATION. A natural spoken answer (~90–130 words) that I read aloud AS my ' +
    'answer — it must sound like talking, not like an essay being recited. Open by actually ' +
    'answering in one short sentence. Then the how and the why, with ONE specific detail from ' +
    'the context doing the convincing. End on a short line that lands the point. Short ' +
    'sentences, plain connectors, 2–3 short paragraphs as breathing points. Warm and direct, ' +
    "never a lecture — exactly the way I'd say it across the table.",
  detailed:
    'FORMAT = DETAILED. A thorough, well-structured spoken answer (~150–220 words) with ' +
    'specifics and one concrete example drawn from the context. Still speech, not an essay: ' +
    'short sentences, clear spoken signposts ("First…", "The tricky part was…", "The result…"), ' +
    'and short paragraphs as breathing points.',
  story_teller:
    'FORMAT = STORY TELLER. You are ME telling MY OWN story on my behalf, written exactly the ' +
    "way I'd tell it out loud (~110–150 words). Shape: a one-line hook that drops us into the " +
    'moment; the stakes in a sentence; what I actually did, as two or three concrete moves; ' +
    'then how it ended, with a real result from the context. Keep the timeline straight — no ' +
    'flashbacks, no nested asides. Short sentences with rhythm, a beat of tension before the ' +
    'payoff, and a paragraph break wherever I would pause. One story, tightly told, effortless ' +
    'to speak on the first read.',
  star:
    'FORMAT = STAR. You are ME answering a behavioural question under the STAR scaffold, spoken ' +
    'aloud (~120–170 words). Four beats, in order, each led by its label on its own line — ' +
    'Situation, Task, Action, Result — so I can see at a glance which beat I am on. ' +
    'SITUATION: one or two sentences of context, enough to make the stakes real. ' +
    'TASK: what *I* specifically was responsible for — not what the team was. This is the beat ' +
    'people skip, and the one panels probe. ACTION: two or three concrete moves I made, in ' +
    'first person singular ("I did", never "we did"), each a decision rather than a duty. ' +
    'RESULT: how it ended, with the most specific figure or outcome the context actually ' +
    'supports — and never invent one; if the context has no number, say what changed in plain ' +
    'words. Keep each beat speakable in one breath.',
};

/** Hard output ceiling per format — the model literally cannot exceed this, so
 *  "key points" can never drift into a long answer regardless of the prompt. */
const FORMAT_MAX_TOKENS: Record<AnswerFormat, number> = {
  key_points: 220,
  explanation: 340,
  detailed: 800,
  story_teller: 420,
  // Four labelled beats cost more than one flowing story, and the Result beat
  // is the one that must not get truncated — it is the point of the answer.
  star: 520,
};

export type AnswerEvent =
  | { type: 'delta'; token: string }
  | { type: 'meta'; riskWarning: string | null }
  | { type: 'usage'; prompt: number; completion: number };

/** The role paragraph — the ONLY part of the prompt that knows what kind of
 *  conversation this is. Everything after it is shared, because "speakable,
 *  human, cited, never fabricated" is true of every mode. */
const ROLE: Record<AnswerFraming, string> = {
  interview: `You ARE the candidate — a second version of them — answering the interview ON
THEIR BEHALF, in first person, as if they are speaking. Never say "the candidate" or "they";
you are them ("I led…", not "The candidate led…"). Your output is a cue card they READ ALOUD,
live, while the interviewer watches — every line must be effortless to say on the first try.`,
  conversation: `You ARE the user — a second version of them — speaking ON THEIR BEHALF in a
live conversation: a meeting, a call, a working session. Never say "the user" or "they"; you
are them ("I shipped…", not "They shipped…"). Your output is a cue they READ ALOUD, live,
while the conversation carries on — every line must be effortless to say on the first try.`,
};

/** What "the person" is called in the shared rules. Keeps the interview prompt
 *  byte-identical to v1 while the conversation prompt stops calling someone in
 *  their own standup a candidate. */
const SUBJECT: Record<AnswerFraming, string> = {
  interview: 'candidate',
  conversation: 'user',
};

const CLOSING_RULE: Record<AnswerFraming, string> = {
  interview: '- Match the interview type.',
  conversation:
    '- ANSWER THE CONVERSATION THAT IS ACTUALLY HAPPENING. Nobody is assessing them here, so\n' +
    '  never sell, never perform credentials, and never pitch their background unless the\n' +
    '  question genuinely asks about it. Say the useful thing and stop.',
};

/** What to do when the context cannot support the question. The interview
 *  text is v1, byte-for-byte. The conversation text exists because the
 *  interview wording ("not in their background… transferable skills") never
 *  fired in a meeting: asked for a budget with no notes, the model produced a
 *  plausible dollar figure — the one thing a cue card must never do. */
const FABRICATION_GUARD: Record<AnswerFraming, string> = {
  interview:
    '- FABRICATION GUARD: if the context can\'t support what\'s asked, do NOT make it up. Begin\n' +
    '  the answer with "⚠", state in one short clause that it\'s not in their background, then\n' +
    '  pivot to a grounded, cited, transferable-skills framing (this is the riskWarning case).',
  conversation:
    '- FABRICATION GUARD: if the context does not contain the specific thing asked for — a\n' +
    '  figure, a date, a decision, a name, a status — do NOT make it up, and NEVER produce a\n' +
    '  plausible-sounding number or range in its place. Begin the answer with "⚠", say in one\n' +
    '  short clause that it is not in their notes, then give only what IS grounded: what the\n' +
    '  notes do say about it, who or where would have the answer, or the one question to ask\n' +
    '  back. A short honest answer beats a confident invented one every time.',
};

/** The card's risk line when nothing in the Space matched the question. */
const NO_CONTEXT_WARNING: Record<AnswerFraming, string> = {
  interview: 'No matching profile experience found.',
  conversation: 'Nothing in this Space covers this — the answer is not grounded.',
};

const buildSystem = (framing: AnswerFraming): string => `${ROLE[framing]}
Rules:
- FORMAT is a HARD constraint. Obey the requested format EXACTLY — even if you have more
  to say. When unsure, be shorter. Never pad. (KEY POINTS especially must stay tiny.)
- WRITE FOR THE EAR, not the page. This is speech: short sentences (aim under 15 words),
  one idea per sentence, subject and verb up front. No nested clauses, no parentheticals,
  no semicolons. Plain spoken connectors ("So", "And", "But", "That meant…") — never
  essay glue. Round numbers the way people say them ("about 40%", "a couple of weeks");
  spell out what's spoken ("for example", never "e.g."). A paragraph is one breath —
  one to three sentences, then a blank line. If a sentence can't be said in one breath
  without stumbling, split it.
- SOUND 100% HUMAN — never AI-generated. Write the way a sharp person actually speaks: use
  contractions ("I've", "didn't", "we're"), vary sentence length, get straight to the point.
  BANNED (AI/corporate tells): "As an AI", "I'd be happy to", "It's worth noting", "Furthermore",
  "Moreover", "In today's … world", "leverage", "delve", "robust", "seamless", and hedging like
  "I believe/I think/arguably/potentially". Don't restate the question. Lead with the answer,
  confidently. Natural ≠ disfluent — do NOT fake "um"/"uh".
- CITE YOUR SOURCES. The CONTEXT items are NUMBERED [1], [2], …. Cite at the end of the
  sentence or clause the claim closes, e.g. "…cut p99 latency about 40% [1]." — never
  mid-phrase, so the marks don't break the reading flow. Cite only real context numbers;
  never invent a citation.
- Ground every SPECIFIC claim (employers, projects, metrics, dates) ONLY in the context.
  Use (company) context to tailor — but NEVER invent the ${SUBJECT[framing]}'s own experience or
  numbers that aren't there. Generic best-practice statements need no citation.
${FABRICATION_GUARD[framing]}
${CLOSING_RULE[framing]}
- Formatting: lead with the single most important line; **bold** only the few words that
  anchor the eye mid-glance; bullets for KEY POINTS and connected sentences for everything
  else; no headers, no stage directions, no meta-commentary — every word on the card must
  be safe to say out loud.`;

/** What stands in for the context when nothing matched. The interview line is
 *  v1. The conversation line is deliberately blunt and sits exactly where the
 *  model looks for facts: with only the system-prompt guard, a meeting answer
 *  to "what is our Q3 budget" still asserted a status ("pending finance
 *  approval") it had no basis for. */
const NO_CONTEXT_LINE: Record<AnswerFraming, string> = {
  interview: '(no relevant profile context found)',
  conversation:
    '(NOTHING in this Space matches the question. You have NO facts about it — no figure, no ' +
    'status, no decision, no owner. Apply the FABRICATION GUARD: start with "⚠", say it is not ' +
    'in the notes, and do not assert anything about it as if it were known.)',
};

function buildContext(chunks: RetrievedChunk[], framing: AnswerFraming = 'interview'): string {
  if (chunks.length === 0) return NO_CONTEXT_LINE[framing];
  return chunks.map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.content}`).join('\n\n');
}

/** The memory block ([M1]… numbering — deliberately separate from the [n]
 *  document-context numbers so a citation can never be ambiguous). Exported
 *  for tests. */
export function buildMemoryBlock(memories: RetrievedMemory[]): string {
  return memories.map((m, i) => `[M${i + 1}] (${m.category}) ${m.content}`).join('\n\n');
}

/** Renders the session-so-far block: what was heard and what was already
 *  answered, oldest first, labeled so the model never mistakes it for CONTEXT. */
export function buildHistoryBlock(history: SessionHistory): string {
  return history
    .map((h) => {
      if (h.role !== 'heard') return `Asked: ${h.question}\nYou answered: ${h.answer}`;
      // The user's own words (their microphone) are labeled as theirs, so the
      // model can tell what was put to them from what they already said —
      // "you" is the same person the answer is written as (first person).
      const own = h.speaker !== undefined && normalizeSpeaker(h.speaker) === 'you';
      return own ? `You said: ${h.text}` : `Heard: ${h.text}`;
    })
    .join('\n');
}

/**
 * Streams the direct answer as deltas, then yields a structured meta event.
 * Skeleton: streams the prose answer; meta is requested as a final JSON pass.
 */
export async function* streamAnswer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
  const framing: AnswerFraming = input.framing ?? 'interview';
  const userPrompt = [
    // The interview type steers the answer's shape; outside an interview there
    // is no such thing, and passing 'general' told the model to behave as if
    // there were.
    framing === 'interview' ? `Interview type: ${input.interviewType ?? 'general'}` : '',
    FORMAT_INSTRUCTION[input.format],
    input.pronunciation
      ? 'PRONUNCIATION GUIDE: keep the ANSWER itself clean — do NOT put respellings inline. ' +
        'AFTER the answer, if any words in it are genuinely hard to pronounce (rare, technical, ' +
        'foreign, or proper nouns), add a final section: a line containing exactly ' +
        '[[PRONUNCIATION]], then ONE line per hard word formatted as ' +
        '`word | part of speech | singular form (or — if n/a) | phonetic respelling`. ' +
        'Respelling = lowercase syllables joined by hyphens with the STRESSED syllable in CAPITALS ' +
        '(e.g. "regulations | noun, plural | regulation | reg-yuh-LAY-shunz"). No IPA. Only include ' +
        'genuinely hard words; if none, omit the section entirely.'
      : '',
    framing === 'interview'
      ? `Candidate role target: ${input.profile.targetRole} @ ${input.profile.targetCompany ?? 'n/a'}`
      : // A daily user has no "target role"; naming one would invite the model to
        // answer as if they were applying for it.
        input.profile.targetRole
        ? `About them: ${input.profile.name} — ${input.profile.targetRole}`
        : `About them: ${input.profile.name}`,
    '',
    'CONTEXT:',
    buildContext(input.contextChunks, framing),
    // Memory only ever ADDS a section — with none recalled, the prompt stays
    // byte-identical to v1 (pinned by the existing answer tests).
    ...(input.memories?.length
      ? [
          '',
          `MEMORY (the ${SUBJECT[framing]}'s own saved notes — cite as [M1], [M2]…, separate from the CONTEXT numbers):`,
          buildMemoryBlock(input.memories),
        ]
      : []),
    // The session so far — also additive only. Placed right before the
    // question so a referential follow-up reads against the thing it refers to.
    ...(input.history?.length
      ? [
          '',
          'EARLIER IN THIS CONVERSATION (oldest first). Use it to resolve references in the ' +
            'QUESTION ("that", "the second option", "what about the timeline") and to avoid ' +
            'repeating an answer already given. Do NOT cite it and do NOT restate it:',
          buildHistoryBlock(input.history),
        ]
      : []),
    '',
    `QUESTION: ${input.question}`,
    '',
    input.format === 'key_points'
      ? 'Write the answer now — KEY POINTS only (~60 words max, terse bullets).'
      : 'Write the answer now, in the FORMAT above — first person, natural, and effortless to read aloud on the first try.',
  ]
    .filter(Boolean)
    .join('\n');

  // Transport goes through the chat capability provider (PRD §6.7). The user
  // can still override the answer task to ANY model (Settings → Models) —
  // task→model resolution and reasoning-model quirks (effort param + token
  // headroom) live in the provider.
  const chat = providerFor('chat');
  let emitted = false;
  for await (const ev of chat.stream({
    task: 'answer',
    system: buildSystem(framing),
    user: userPrompt,
    // Hard ceiling per format so "key points" can never run long. Pronunciation adds
    // a short trailing guide, so give it headroom (the guide must not eat the answer).
    maxOutputTokens: FORMAT_MAX_TOKENS[input.format] + (input.pronunciation ? 160 : 0),
    signal: input.signal,
  })) {
    if (ev.type === 'delta') {
      emitted = true;
      yield ev;
    } else if (ev.type === 'usage') {
      yield ev;
    }
  }
  // No visible text at all (e.g. a reasoning model's ceiling was consumed by
  // reasoning): surface a real error instead of leaving a silently blank card.
  if (!emitted)
    throw new Error(
      'The answer model returned no text. If you overrode the answer model, try a faster non-reasoning one.',
    );

  yield {
    type: 'meta',
    riskWarning: input.contextChunks.length === 0 ? NO_CONTEXT_WARNING[framing] : null,
  };
}
