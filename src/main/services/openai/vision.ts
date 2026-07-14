import { openai } from './client';
import { model, reasoningParam } from './models';
import { codingRules } from './codingPrompt';
import type { AnswerEvent } from './answer';
import type { AnswerFormat } from '@shared/types';

/**
 * Solve a problem from ONE OR MORE screenshots using the 'coding' model (multimodal,
 * a reasoning model by default). A long LeetCode-style problem scrolls past one
 * viewport, so the user captures several overlapping screenshots top-to-bottom and we
 * send them ALL in a single request, instruction-first, in scroll order — the model
 * reconstructs/dedupes them (far more robust than client-side pixel stitching).
 * detail:'high' because code legibility is the whole game.
 */
export async function* solveFromImages(
  dataUrls: string[],
  language: string,
  format: AnswerFormat,
  signal?: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  const system = `You are shown a screenshot containing a coding/technical interview problem (and possibly code). Read it carefully, transcribe the problem accurately, then solve it.\n${codingRules(language, format)}`;
  const intro =
    dataUrls.length > 1
      ? `The following ${dataUrls.length} images are consecutive, top-to-bottom (possibly ` +
        `overlapping) screenshots of ONE coding problem. Reconstruct the full problem text ` +
        `(dedupe the overlapping regions), then solve it.`
      : 'Solve the problem shown in this screenshot.';
  const content = [
    { type: 'input_text' as const, text: intro },
    ...dataUrls.map((url) => ({
      type: 'input_image' as const,
      image_url: url,
      detail: 'high' as const,
    })),
  ];
  const stream = await openai().responses.stream(
    {
      model: model('coding'),
      ...reasoningParam('coding'),
      input: [
        { role: 'system', content: system },
        { role: 'user', content },
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
