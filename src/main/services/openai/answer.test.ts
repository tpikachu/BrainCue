import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnswerEvent } from './answer';

// Capture the request body passed to responses.stream, and feed back a fixed
// fake stream (two text deltas + usage). Mock the model resolver so models.ts →
// db → better-sqlite3 is never loaded.
const h = vi.hoisted(() => ({ lastBody: null as Record<string, unknown> | null }));
vi.mock('./client', () => ({
  openai: () => ({
    responses: {
      stream: (body: Record<string, unknown>) => {
        h.lastBody = body;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'response.output_text.delta', delta: 'Hello' };
            yield { type: 'response.output_text.delta', delta: ' world' };
            yield { type: 'response.ignored.event' }; // non-delta events are skipped
          },
          finalResponse: async () => ({ usage: { input_tokens: 12, output_tokens: 7 } }),
        };
      },
    },
  }),
}));
vi.mock('./models', () => ({ model: () => 'gpt-4.1-mini' }));

import { streamAnswer } from './answer';

const profile = { targetRole: 'SWE', targetCompany: 'Acme' } as Parameters<typeof streamAnswer>[0]['profile'];

function baseInput(over: Partial<Parameters<typeof streamAnswer>[0]> = {}) {
  return {
    question: 'Tell me about a hard bug.',
    contextChunks: [{ id: 'c1', sourceType: 'resume' as const, content: 'Fixed a race condition', score: 0.8 }],
    profile,
    format: 'key_points' as const,
    pronunciation: false,
    interviewType: 'behavioral' as const,
    ...over,
  };
}

async function collect(gen: AsyncGenerator<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const userPrompt = () => String((h.lastBody!.input as { role: string; content: string }[])[1].content);

beforeEach(() => {
  h.lastBody = null;
});

describe('streamAnswer — request body', () => {
  it('caps key_points at 220 output tokens', async () => {
    await collect(streamAnswer(baseInput({ format: 'key_points' })));
    expect(h.lastBody!.max_output_tokens).toBe(220);
    expect(userPrompt()).toContain('KEY POINTS');
    expect(userPrompt()).toContain('~60 words');
  });

  it('caps explanation at 340 output tokens', async () => {
    await collect(streamAnswer(baseInput({ format: 'explanation' })));
    expect(h.lastBody!.max_output_tokens).toBe(340);
    expect(userPrompt()).toContain('EXPLANATION');
  });

  it('caps detailed at 800 output tokens', async () => {
    await collect(streamAnswer(baseInput({ format: 'detailed' })));
    expect(h.lastBody!.max_output_tokens).toBe(800);
    expect(userPrompt()).toContain('DETAILED');
  });

  it('includes the structured pronunciation-guide instruction only when enabled', async () => {
    await collect(streamAnswer(baseInput({ pronunciation: true })));
    expect(userPrompt()).toMatch(/phonetic respelling/i);
    expect(userPrompt()).toContain('[[PRONUNCIATION]]'); // structured guide marker
    await collect(streamAnswer(baseInput({ pronunciation: false })));
    expect(userPrompt()).not.toMatch(/phonetic respelling/i);
    expect(userPrompt()).not.toContain('[[PRONUNCIATION]]');
  });

  it('gives pronunciation headroom above the format token cap', async () => {
    await collect(streamAnswer(baseInput({ format: 'key_points', pronunciation: true })));
    expect(h.lastBody!.max_output_tokens).toBe(220 + 160);
  });

  it('injects the chosen format and interview type', async () => {
    await collect(streamAnswer(baseInput({ format: 'explanation', interviewType: 'coding' })));
    expect(userPrompt()).toContain('EXPLANATION');
    expect(userPrompt()).toContain('Interview type: coding');
  });

  it('instructs a human, anti-AI tone in the system prompt', async () => {
    await collect(streamAnswer(baseInput()));
    const system = String((h.lastBody!.input as { role: string; content: string }[])[0].content);
    expect(system).toMatch(/human/i);
    expect(system).toMatch(/As an AI/i); // it's in the BANNED list
  });

  it('embeds retrieved context tagged by source', async () => {
    await collect(streamAnswer(baseInput()));
    expect(userPrompt()).toContain('(resume) Fixed a race condition');
  });

  it('numbers the context so answers can cite [i]', async () => {
    await collect(streamAnswer(baseInput()));
    expect(userPrompt()).toContain('[1] (resume) Fixed a race condition');
  });

  it('instructs inline [i] citations + a fabrication guard (system prompt)', async () => {
    await collect(streamAnswer(baseInput()));
    const system = String((h.lastBody!.input as { role: string; content: string }[])[0].content);
    expect(system).toMatch(/cite/i);
    expect(system).toContain('[1]');
    expect(system).toMatch(/FABRICATION GUARD|⚠/);
  });

  it('notes when there is NO matching context', async () => {
    await collect(streamAnswer(baseInput({ contextChunks: [] })));
    expect(userPrompt()).toContain('no relevant profile context found');
  });
});

describe('streamAnswer — streamed events', () => {
  it('yields a delta per output_text.delta and skips other events', async () => {
    const evs = await collect(streamAnswer(baseInput()));
    const tokens = evs.filter((e) => e.type === 'delta').map((e) => (e as { token: string }).token);
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('yields a usage event from finalResponse', async () => {
    const evs = await collect(streamAnswer(baseInput()));
    expect(evs).toContainEqual({ type: 'usage', prompt: 12, completion: 7 });
  });

  it('sets a riskWarning in meta only when context is empty', async () => {
    const withCtx = (await collect(streamAnswer(baseInput()))).find((e) => e.type === 'meta');
    expect((withCtx as { riskWarning: string | null }).riskWarning).toBeNull();
    const noCtx = (await collect(streamAnswer(baseInput({ contextChunks: [] })))).find(
      (e) => e.type === 'meta',
    );
    expect((noCtx as { riskWarning: string | null }).riskWarning).toBeTruthy();
  });
});
