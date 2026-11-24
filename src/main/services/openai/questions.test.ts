import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the OpenAI client (the classifier's model response) and the model resolver
// (so models.ts → db → better-sqlite3 is never loaded).
const h = vi.hoisted(() => ({ output: '{}' }));
vi.mock('./client', () => ({
  openai: () => ({ responses: { create: async () => ({ output_text: h.output }) } }),
}));
// The provider layer imports the full models surface + the realtime module
// (whose apiKey → env chain needs electron) — stub both so loading
// providers/openai stays hermetic.
vi.mock('./models', () => ({
  model: () => 'gpt-4.1-nano',
  isReasoningModel: () => false,
  reasoningEffort: () => null,
  EMBEDDING_DIM: 1536,
}));
vi.mock('./realtime', () => ({
  RealtimeTranscriber: class {
    start() {}
    appendAudio() {}
    stop() {}
  },
}));

import { classifyQuestion } from './questions';

beforeEach(() => {
  h.output = '{}';
});

describe('classifyQuestion', () => {
  it('maps a well-formed classifier response', async () => {
    h.output = JSON.stringify({
      isQuestion: true,
      type: 'coding',
      confidence: 0.92,
      strategy: 'lead with the approach',
    });
    const r = await classifyQuestion('reverse a linked list');
    expect(r).toEqual({
      isQuestion: true,
      text: 'reverse a linked list',
      type: 'coding',
      confidence: 0.92,
      strategy: 'lead with the approach',
    });
  });

  it('always echoes the input text, never the model output', async () => {
    h.output = JSON.stringify({ isQuestion: true, text: 'SOMETHING ELSE' });
    const r = await classifyQuestion('the real utterance');
    expect(r.text).toBe('the real utterance');
  });

  it('defaults every field when the model returns an empty object', async () => {
    h.output = '{}';
    const r = await classifyQuestion('hello');
    expect(r).toEqual({
      isQuestion: false, // safe default: don't answer on uncertainty
      text: 'hello',
      type: 'behavioral',
      confidence: 0,
      strategy: '',
    });
  });

  it('treats a missing isQuestion as not-a-question (false), not truthy', async () => {
    h.output = JSON.stringify({ type: 'product', confidence: 0.5 });
    const r = await classifyQuestion('mm-hmm');
    expect(r.isQuestion).toBe(false);
  });

  it('keeps confidence 0 when omitted (so the >=0.4 gate fails closed)', async () => {
    h.output = JSON.stringify({ isQuestion: true });
    const r = await classifyQuestion('uh');
    expect(r.confidence).toBe(0);
  });

  // Documents a known gap: output_text is parsed without a guard. json_object format
  // makes this unlikely, but malformed JSON currently rejects (caught upstream in
  // processFinalTranscript). If this is ever hardened, update this test.
  // Malformed JSON still rejects — the interview detector catches it and
  // falls back to the heuristic decision (engine/interview/detector.ts).
  it('rejects on malformed JSON (the detector owns the fallback)', async () => {
    h.output = 'not json at all';
    await expect(classifyQuestion('x')).rejects.toThrow();
  });

  it('rejects a JSON value that is not an object', async () => {
    h.output = '[true]';
    await expect(classifyQuestion('x')).rejects.toThrow(/JSON object/);
  });

  it('a wrongly-typed field fails closed instead of passing through', async () => {
    h.output = JSON.stringify({ isQuestion: 'yes', confidence: 'high', type: 'weird' });
    const r = await classifyQuestion('x');
    expect(r.isQuestion).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.type).toBe('behavioral');
  });

  it('an out-of-range confidence is not trusted', async () => {
    h.output = JSON.stringify({ isQuestion: true, confidence: 7 });
    expect((await classifyQuestion('x')).confidence).toBe(0);
  });

  it('surfaces continuesPrevious only when the model says so', async () => {
    h.output = JSON.stringify({ isQuestion: true, confidence: 0.8, continuesPrevious: true });
    expect((await classifyQuestion('and how you tested it')).continuesPrevious).toBe(true);
  });
});
