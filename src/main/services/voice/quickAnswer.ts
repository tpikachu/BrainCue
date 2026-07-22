import { providerFor } from '../../providers/registry';
import { buildMemoryBlock } from '../openai/answer';
import type { AnswerEvent } from '../openai/answer';
import type { RetrievedChunk, RetrievedMemory } from '@shared/types';

/**
 * The no-session quick ask: the user summons BrainCue directly (push-to-talk
 * with nothing live) and gets a short, speakable reply grounded in their
 * default Space. Deliberately NOT the interview persona (which answers AS the
 * candidate) — this is BrainCue answering the user. Prompt lives here in the
 * service; transport goes through the chat capability (provider seam).
 */

const SYSTEM = `You are BrainCue, a local-first assistant, answering the user directly.
Your reply is SPOKEN ALOUD by text-to-speech AND shown as text, so write for the ear:
- Be brief: 2–5 short sentences unless the question truly needs more. Lead with the answer.
- Short sentences, plain words, contractions. No headers, no bullet lists, no markdown
  emphasis — punctuation the voice can speak.
- CONTEXT items are numbered [1], [2], … and MEMORY items [M1], [M2], …. Ground specific
  claims in them and cite at the end of the sentence the claim closes. Never invent a
  citation; generic knowledge needs none.
- If the context doesn't cover what's asked, say so in one clause and answer from general
  knowledge — never fabricate the user's own facts.`;

function buildContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no relevant context found)';
  return chunks.map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.content}`).join('\n\n');
}

export async function* streamQuickAnswer(input: {
  question: string;
  contextChunks: RetrievedChunk[];
  memories: RetrievedMemory[];
  signal?: AbortSignal;
}): AsyncGenerator<AnswerEvent> {
  const user = [
    'CONTEXT:',
    buildContext(input.contextChunks),
    ...(input.memories.length
      ? ['', "MEMORY (the user's own saved notes — cite as [M1]…):", buildMemoryBlock(input.memories)]
      : []),
    '',
    `QUESTION: ${input.question}`,
    '',
    'Answer now — spoken style, brief, grounded.',
  ].join('\n');

  const chat = providerFor('chat');
  for await (const ev of chat.stream({
    task: 'answer',
    system: SYSTEM,
    user,
    maxOutputTokens: 400,
    signal: input.signal,
  })) {
    if (ev.type === 'delta' || ev.type === 'usage') yield ev;
  }
  yield { type: 'meta', riskWarning: null };
}
