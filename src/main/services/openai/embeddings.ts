import { openai } from './client';
import { model } from './models';

/** Embed a batch of texts. Returns one Float32Array per input. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const res = await openai().embeddings.create({
    model: model('embedding'),
    input: texts,
  });
  return res.data.map((d) => Float32Array.from(d.embedding));
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embed([text]);
  if (!v) throw new Error('Embedding API returned no vector.');
  return v;
}
