import { openai } from './client';
import { model, reasoningParam } from './models';
import { visionSolvePrompt } from './codingPrompt';
import type { AnswerEvent } from './answer';
import type { AnswerFormat } from '@shared/types';

/**
 * OpenAI transport for the screenshot solver ('coding' model — multimodal, a
 * reasoning model by default). The prompt is shared with the other vision
 * adapters (`visionSolvePrompt`); this file only shapes the Responses-API
 * request: instruction-first, images in scroll order, detail:'high' because
 * code legibility is the whole game. Reached through `providerFor('vision')`.
 */
export async function* solveFromImages(
  dataUrls: string[],
  language: string,
  format: AnswerFormat,
  signal?: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  const { system, intro } = visionSolvePrompt(dataUrls.length, language, format);
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
