import { openai } from './client';
import { model, reasoningParam } from './models';
import { codingRules } from './codingPrompt';
import type { AnswerEvent } from './answer';
import type { AnswerFormat } from '@shared/types';

/** Stream a coding-mode answer from clipboard/OCR'd problem text. Uses the dedicated
 *  'coding' model (a reasoning model by default) — the same solver as the screenshot
 *  path, so both stay consistently smart. Solution written in `language`; the four-beat
 *  delivery (understanding → plan → code → evaluation) is shaped by `format`. */
export async function* solveFromOcr(
  text: string,
  language: string,
  format: AnswerFormat,
  signal?: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  const system = `You solve a coding/technical problem given as plain text.\n${codingRules(language, format)}`;
  const stream = await openai().responses.stream(
    {
      model: model('coding'),
      ...reasoningParam('coding'),
      input: [
        { role: 'system', content: system },
        { role: 'user', content: text.slice(0, 12_000) },
      ],
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      yield { type: 'delta', token: event.delta };
    }
  }
  yield { type: 'meta', riskWarning: null };
}
