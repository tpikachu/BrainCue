import { openai } from './client';
import { isReasoningModel, model, reasoningEffort } from './models';
import type { AnswerFormat, InterviewType, Profile, RetrievedChunk } from '@shared/types';

export interface AnswerInput {
  question: string;
  contextChunks: RetrievedChunk[];
  profile: Profile;
  /** The single answer control (v1.2): key_points | explanation | detailed. */
  format: AnswerFormat;
  /** Annotate rare/technical/foreign terms with a quick phonetic respelling. */
  pronunciation: boolean;
  interviewType: InterviewType;
  signal?: AbortSignal;
}

/** Human-readable instruction per answer FORMAT, injected into the prompt. */
const FORMAT_INSTRUCTION: Record<AnswerFormat, string> = {
  key_points:
    'FORMAT = KEY POINTS (STRICT). A glanceable cue to speak FROM, not a full answer. ' +
    'Hard cap: ~60 words TOTAL. One short opening line (≤12 words), then 2–3 terse bullets of a ' +
    'few words each — keywords/phrases, not sentences. No paragraphs, no preamble. Shorter is better.',
  explanation:
    "FORMAT = EXPLANATION. A natural, flowing first-person answer (~90–130 words) — the way you'd " +
    'actually talk it through with someone. Connected sentences, NOT bullets. Lead with the point, ' +
    'then the how/why with one specific detail from the context. Warm and direct, never a lecture.',
  detailed:
    'FORMAT = DETAILED. A thorough, well-structured spoken answer (~150–220 words) with specifics ' +
    'and one concrete example drawn from the context. Natural spoken language, not an essay.',
  story_teller:
    'FORMAT = STORY TELLER. You are ME telling MY OWN story on my behalf. Tell it as a short, vivid ' +
    'first-person STORY (~110–150 words): a quick hook, the challenge/stakes, what I actually did, and ' +
    'how it turned out (with a real result from the context). Flowing narrative, not bullets — ' +
    'memorable and natural, the way I would tell it in the room. One story, tightly told.',
};

/** Hard output ceiling per format — the model literally cannot exceed this, so
 *  "key points" can never drift into a long answer regardless of the prompt. */
const FORMAT_MAX_TOKENS: Record<AnswerFormat, number> = {
  key_points: 220,
  explanation: 340,
  detailed: 800,
  story_teller: 420,
};

export type AnswerEvent =
  | { type: 'delta'; token: string }
  | { type: 'meta'; riskWarning: string | null }
  | { type: 'usage'; prompt: number; completion: number };

const SYSTEM = `You ARE the candidate — a second version of them — answering the interview ON
THEIR BEHALF, in first person, as if they are speaking. Never say "the candidate" or "they";
you are them ("I led…", not "The candidate led…"). They read your output WHILE speaking in a
real interview, so it must be instantly skimmable.
Rules:
- FORMAT is a HARD constraint. Obey the requested format EXACTLY — even if you have more
  to say. When unsure, be shorter. Never pad. (KEY POINTS especially must stay tiny.)
- SOUND 100% HUMAN — never AI-generated. Write the way a sharp person actually speaks: use
  contractions ("I've", "didn't", "we're"), vary sentence length, get straight to the point.
  BANNED (AI/corporate tells): "As an AI", "I'd be happy to", "It's worth noting", "Furthermore",
  "Moreover", "In today's … world", "leverage", "delve", "robust", "seamless", and hedging like
  "I believe/I think/arguably/potentially". Don't restate the question. Lead with the answer,
  confidently. Natural ≠ disfluent — do NOT fake "um"/"uh".
- CITE YOUR SOURCES. The CONTEXT items are NUMBERED [1], [2], …. Immediately after each
  claim drawn from the context, cite its number(s) inline, e.g. "cut p99 latency ~40% [1]"
  or "[2][3]". Cite only real context numbers; never invent a citation.
- Ground every SPECIFIC claim (employers, projects, metrics, dates) ONLY in the context.
  Use (company) context to tailor — but NEVER invent the candidate's own experience or
  numbers that aren't there. Generic best-practice statements need no citation.
- FABRICATION GUARD: if the context can't support what's asked, do NOT make it up. Begin
  the answer with "⚠", state in one short clause that it's not in their background, then
  pivot to a grounded, cited, transferable-skills framing (this is the riskWarning case).
- Match the interview type.
- Formatting: lead with the single most important line; **bold** only true key terms; use
  bullets for KEY POINTS and connected sentences for EXPLANATION/DETAILED; no headers or
  meta-commentary.`;

function buildContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no relevant profile context found)';
  return chunks.map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.content}`).join('\n\n');
}

/**
 * Streams the direct answer as deltas, then yields a structured meta event.
 * Skeleton: streams the prose answer; meta is requested as a final JSON pass.
 */
export async function* streamAnswer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
  const userPrompt = [
    `Interview type: ${input.interviewType}`,
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
    `Candidate role target: ${input.profile.targetRole} @ ${input.profile.targetCompany ?? 'n/a'}`,
    '',
    'CONTEXT:',
    buildContext(input.contextChunks),
    '',
    `QUESTION: ${input.question}`,
    '',
    input.format === 'key_points'
      ? 'Write the answer now — KEY POINTS only (~60 words max, terse bullets).'
      : 'Write the answer now, in the FORMAT above — natural, human, first-person.',
  ]
    .filter(Boolean)
    .join('\n');

  // The user can override the answer task to ANY model (Settings → OpenAI Models),
  // including gpt-5/o-series. Reasoning models burn hidden reasoning tokens against
  // max_output_tokens FIRST, so without headroom + an explicit low effort the tight
  // per-format ceiling would be consumed before any visible text is emitted.
  const answerModel = model('answer');
  const reasoning = isReasoningModel(answerModel);

  const stream = await openai().responses.stream(
    {
      model: answerModel,
      ...(reasoning ? { reasoning: { effort: reasoningEffort('answer') ?? 'low' } } : {}),
      // Hard ceiling per format so "key points" can never run long. Pronunciation adds
      // a short trailing guide, so give it headroom (the guide must not eat the answer).
      max_output_tokens:
        FORMAT_MAX_TOKENS[input.format] +
        (input.pronunciation ? 160 : 0) +
        (reasoning ? 1024 : 0), // reasoning-token headroom; the prompt still binds length
      input: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    },
    { signal: input.signal },
  );

  let emitted = false;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      emitted = true;
      yield { type: 'delta', token: event.delta };
    }
  }
  // No visible text at all (e.g. the ceiling was still consumed by reasoning): surface
  // a real error instead of leaving a silently blank card.
  if (!emitted)
    throw new Error(
      'The answer model returned no text. If you overrode the answer model, try a faster non-reasoning one.',
    );

  const final = await stream.finalResponse();
  const usage = final.usage;
  if (usage) {
    yield {
      type: 'usage',
      prompt: usage.input_tokens ?? 0,
      completion: usage.output_tokens ?? 0,
    };
  }

  yield {
    type: 'meta',
    riskWarning: input.contextChunks.length === 0 ? 'No matching profile experience found.' : null,
  };
}
