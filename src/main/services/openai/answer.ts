import { openai } from './client';
import { model } from './models';
import type {
  AnswerLength,
  AnswerStyle,
  InterviewType,
  Profile,
  RetrievedChunk,
} from '@shared/types';

export interface AnswerInput {
  question: string;
  contextChunks: RetrievedChunk[];
  profile: Profile;
  style: AnswerStyle;
  length: AnswerLength;
  /** Annotate rare/technical/foreign terms with a quick phonetic respelling. */
  pronunciation: boolean;
  interviewType: InterviewType;
  signal?: AbortSignal;
}

/** Human-readable instruction for each length, injected into the prompt. */
const LENGTH_INSTRUCTION: Record<AnswerLength, string> = {
  key_points:
    'LENGTH = KEY POINTS (STRICT). This is a glanceable cue to speak FROM, not a full answer. ' +
    'Hard cap: ~60 words TOTAL. Format: one short opening line (≤12 words), then 2–3 terse ' +
    'bullets of a few words each — keywords/phrases, not sentences. No paragraphs. No preamble. ' +
    'If a bullet reads like a full sentence, cut it down. Shorter is better.',
  detailed:
    'LENGTH = DETAILED. A thorough, well-structured spoken answer (~120–200 words) with specifics ' +
    'and one concrete example drawn from the context. Natural spoken language, not an essay.',
};

/** Hard output ceiling per length — the model literally cannot exceed this, so
 *  "key points" can never drift into a long answer regardless of the prompt. */
const LENGTH_MAX_TOKENS: Record<AnswerLength, number> = {
  key_points: 220,
  detailed: 800,
};

/** Format/tone instruction per style. */
const STYLE_INSTRUCTION: Record<AnswerStyle, string> = {
  default: 'Format: a clear, direct spoken answer.',
  star: 'Format: STAR — frame the answer as Situation, Task, Action, Result.',
  technical: 'Format: technical — precise, correct terminology; lead with the core concept.',
  conversational: 'Format: conversational — warm, natural, first-person, like talking to a person.',
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
- LENGTH is a HARD constraint. Obey the requested length EXACTLY — even if you have more
  to say. When unsure, be shorter. Never pad. (KEY POINTS especially must stay tiny.)
- Ground every answer ONLY in the provided context (resume, job description, notes,
  company research), tagged by source, e.g. (resume), (jd), (company).
- Use (company) context to tailor answers to the company — but NEVER invent the
  candidate's own experience, employers, projects, or metrics that aren't in the
  resume/notes. No fabricated numbers.
- If the context lacks relevant experience, say so briefly (riskWarning) and offer a
  safe transferable-skills framing instead of fabricating.
- Then follow the requested FORMAT and the interview type.
- Formatting: lead with the single most important line; **bold** only true key terms;
  prefer short bullets over dense paragraphs; no meta-commentary or headers.`;

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
    LENGTH_INSTRUCTION[input.length],
    STYLE_INSTRUCTION[input.style],
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
    input.length === 'key_points'
      ? 'Write the answer now — KEY POINTS only (~60 words max, terse bullets).'
      : 'Write the direct spoken answer now, respecting the length above.',
  ]
    .filter(Boolean)
    .join('\n');

  const stream = await openai().responses.stream(
    {
      model: model('answer'),
      // Hard ceiling per length so "key points" can never run long.
      max_output_tokens: LENGTH_MAX_TOKENS[input.length],
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
