import { providerFor } from '../../providers/registry';
import { codingRules } from './codingPrompt';
import type { AnswerEvent } from './answer';
import type { AnswerFormat } from '@shared/types';

/** Stream a coding-mode answer from clipboard/OCR'd problem text. Uses the dedicated
 *  'coding' task (a reasoning model by default) — the same solver as the screenshot
 *  path, so both stay consistently smart. Solution written in `language`; the four-beat
 *  delivery (understanding → plan → code → evaluation) is shaped by `format`.
 *  Transport comes from the chat seam, so the task's model may live on any
 *  provider (`anthropic/claude-fable-5-1` for the solver, say) — the OpenAI
 *  adapter still sends the reasoning effort + headroom this path always did. */
export async function* solveFromOcr(
  text: string,
  language: string,
  format: AnswerFormat,
  signal?: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  const system = `You solve a coding/technical problem given as plain text.\n${codingRules(language, format)}`;
  yield* providerFor('chat').stream({
    task: 'coding',
    system,
    user: text.slice(0, 12_000),
    signal,
  });
  yield { type: 'meta', riskWarning: null };
}
