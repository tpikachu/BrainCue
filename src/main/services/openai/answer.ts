import { openai } from './client';
import { model } from './models';
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
};

/** Hard output ceiling per format — the model literally cannot exceed this, so
 *  "key points" can never drift into a long answer regardless of the prompt. */
const FORMAT_MAX_TOKENS: Record<AnswerFormat, number> = {
  key_points: 220,
  explanation: 340,
  detailed: 800,
};

export type AnswerEvent =
  | { type: 'delta'; token: string }
  | {
      type: 'meta';
      talkingPoints: string[];
      resumeMatch: string | null;
      star: { situation: string; task: string; action: string; result: string } | null;
      clarifyingQuestion: string | null;
      riskWarning: string | null;
      followupQuestion: string | null;
    }
  | { type: 'usage'; prompt: number; completion: number };

const SYSTEM = `You are a live interview copilot. The candidate reads your output WHILE
speaking in a real interview, so it must be instantly skimmable and spoken in their
first-person voice ("I led…", not "The candidate led…").
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
      ? 'Pronunciation: for rare, technical, or foreign terms, add a simple phonetic respelling in ' +
        'parentheses the FIRST time each appears — lowercase syllables joined by hyphens, with the ' +
        'STRESSED syllable in CAPITALS, e.g. "regulations (reg-yuh-LAY-shunz)", ' +
        '"Kubernetes (koo-ber-NET-eez)", "Nguyen (WIN)". No IPA symbols. Common words need none.'
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

  const stream = await openai().responses.stream(
    {
      model: model('answer'),
      // Hard ceiling per format so "key points" can never run long.
      max_output_tokens: FORMAT_MAX_TOKENS[input.format],
      input: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    },
    { signal: input.signal },
  );

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      yield { type: 'delta', token: event.delta };
    }
  }

  const final = await stream.finalResponse();
  const usage = final.usage;
  if (usage) {
    yield {
      type: 'usage',
      prompt: usage.input_tokens ?? 0,
      completion: usage.output_tokens ?? 0,
    };
  }

  // M2: a second cheap structured pass produces talking points / STAR / warnings.
  // Stubbed here so the contract is in place.
  yield {
    type: 'meta',
    talkingPoints: [],
    resumeMatch: null,
    star: null,
    clarifyingQuestion: null,
    riskWarning: input.contextChunks.length === 0 ? 'No matching profile experience found.' : null,
    followupQuestion: null,
  };
}
