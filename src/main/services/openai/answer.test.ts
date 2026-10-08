import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnswerEvent } from './answer';

// Capture the request body passed to responses.stream, and feed back a fixed
// fake stream (two text deltas + usage). Mock the model resolver so models.ts →
// db → better-sqlite3 is never loaded.
const h = vi.hoisted(() => ({
  lastBody: null as Record<string, unknown> | null,
  reasoning: false, // pretend the resolved answer model is a reasoning model
  emitText: true, // pretend the stream produced visible text
}));
vi.mock('./client', () => ({
  openai: () => ({
    responses: {
      stream: (body: Record<string, unknown>) => {
        h.lastBody = body;
        return {
          async *[Symbol.asyncIterator]() {
            if (!h.emitText) return; // reasoning ate the whole budget — no text
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
vi.mock('./models', () => ({
  model: () => (h.reasoning ? 'gpt-5-mini' : 'gpt-4.1-mini'),
  isReasoningModel: () => h.reasoning,
  reasoningEffort: () => null,
  EMBEDDING_DIM: 1536, // imported by the provider layer
}));
// The provider layer also loads the realtime module, whose apiKey → env chain
// needs electron — stub it out.
vi.mock('./realtime', () => ({
  RealtimeTranscriber: class {
    start() {}
    appendAudio() {}
    stop() {}
  },
}));

import { streamAnswer } from './answer';

const profile = { targetRole: 'SWE', targetCompany: 'Acme' } as Parameters<typeof streamAnswer>[0]['profile'];

function baseInput(over: Partial<Parameters<typeof streamAnswer>[0]> = {}) {
  return {
    question: 'Tell me about a hard bug.',
    contextChunks: [{ id: 'c1', sourceType: 'resume' as const, content: 'Fixed a race condition', score: 0.8 }],
    profile,
    format: 'general' as const,
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
  h.reasoning = false;
  h.emitText = true;
});

describe('streamAnswer — request body', () => {
  it('GENERAL: bold lead sentence + 3–4 bullets, capped at 360 output tokens', async () => {
    await collect(streamAnswer(baseInput({ format: 'general' })));
    expect(h.lastBody!.max_output_tokens).toBe(360);
    const p = userPrompt();
    expect(p).toContain('FORMAT = GENERAL');
    expect(p).toMatch(/ONE sentence that actually answers the question, in \*\*bold\*\*/);
    expect(p).toContain('3–4 short bullets');
    expect(p).toContain('~120 words max');
    expect(p).toContain('Write the answer now — GENERAL');
  });

  it('TECHNICAL: same lead, 4–6 specific bullets, then approach + trade-offs, capped at 600', async () => {
    await collect(streamAnswer(baseInput({ format: 'technical' })));
    expect(h.lastBody!.max_output_tokens).toBe(600);
    const p = userPrompt();
    expect(p).toContain('FORMAT = TECHNICAL');
    expect(p).toMatch(/in \*\*bold\*\*/);
    expect(p).toContain('4–6 bullets');
    expect(p).toMatch(/one line of\s+code/);
    expect(p).toContain('trade-offs');
    expect(p).toContain('~200 words max');
    expect(p).toContain('Write the answer now — TECHNICAL');
  });

  it('never mentions the retired five formats', async () => {
    for (const format of ['general', 'technical'] as const) {
      await collect(streamAnswer(baseInput({ format })));
      expect(userPrompt()).not.toMatch(/KEY POINTS|STORY TELLER|FORMAT = STAR|FORMAT = DETAILED|FORMAT = EXPLANATION/);
    }
  });

  it('a BEHAVIORAL question under the interview framing gets the story shape automatically', async () => {
    await collect(streamAnswer(baseInput({ format: 'general', questionType: 'behavioral' })));
    const p = userPrompt();
    expect(p).toMatch(/order the bullets as the story: the situation, what I\s+did/);
    expect(p).toMatch(/then the result/);
    expect(p).toMatch(/first person singular/);
    expect(p).toMatch(/never an invented one/); // a fabricated metric is worse than none
    expect(p).toMatch(/No labels/); // no Situation/Task/Action/Result headings
    // Same under TECHNICAL — the shape rides on the question, not the style.
    await collect(streamAnswer(baseInput({ format: 'technical', questionType: 'behavioral' })));
    expect(userPrompt()).toMatch(/order the bullets as the story/);
  });

  it('no story shape without a behavioral question type, or outside the interview framing', async () => {
    await collect(streamAnswer(baseInput()));
    expect(userPrompt()).not.toMatch(/order the bullets as the story/);
    await collect(streamAnswer(baseInput({ questionType: 'technical' })));
    expect(userPrompt()).not.toMatch(/order the bullets as the story/);
    await collect(streamAnswer(baseInput({ questionType: 'behavioral', framing: 'conversation' })));
    expect(userPrompt()).not.toMatch(/order the bullets as the story/);
  });

  it('includes the structured pronunciation-guide instruction only when enabled', async () => {
    await collect(streamAnswer(baseInput({ pronunciation: true })));
    expect(userPrompt()).toMatch(/phonetic respelling/i);
    expect(userPrompt()).toContain('[[PRONUNCIATION]]'); // structured guide marker
    await collect(streamAnswer(baseInput({ pronunciation: false })));
    expect(userPrompt()).not.toMatch(/phonetic respelling/i);
    expect(userPrompt()).not.toContain('[[PRONUNCIATION]]');
  });

  it('gives pronunciation headroom above the style token cap', async () => {
    await collect(streamAnswer(baseInput({ format: 'general', pronunciation: true })));
    expect(h.lastBody!.max_output_tokens).toBe(360 + 160);
  });

  it('on a reasoning answer model: sends a low effort + reasoning-token headroom', async () => {
    h.reasoning = true;
    await collect(streamAnswer(baseInput({ format: 'general' })));
    expect(h.lastBody!.reasoning).toEqual({ effort: 'low' });
    expect(h.lastBody!.max_output_tokens).toBe(360 + 1024);
  });

  it('never sends a reasoning param to a non-reasoning model', async () => {
    await collect(streamAnswer(baseInput()));
    expect(h.lastBody!.reasoning).toBeUndefined();
  });

  it('throws (instead of a silent blank card) when the stream emits no text', async () => {
    h.emitText = false;
    await expect(collect(streamAnswer(baseInput()))).rejects.toThrow(/no text/i);
  });

  it('injects the chosen style and interview type', async () => {
    await collect(streamAnswer(baseInput({ format: 'technical', interviewType: 'coding' })));
    expect(userPrompt()).toContain('FORMAT = TECHNICAL');
    expect(userPrompt()).toContain('Interview type: coding');
  });

  it('instructs a human, anti-AI tone in the system prompt', async () => {
    await collect(streamAnswer(baseInput()));
    const system = String((h.lastBody!.input as { role: string; content: string }[])[0].content);
    expect(system).toMatch(/human/i);
    expect(system).toMatch(/As an AI/i); // it's in the BANNED list
  });

  it('writes for the ear: system demands speakable prose; both styles demand read-aloud fluency', async () => {
    await collect(streamAnswer(baseInput({ format: 'general' })));
    const system = String((h.lastBody!.input as { role: string; content: string }[])[0].content);
    expect(system).toMatch(/WRITE FOR THE EAR/i);
    expect(system).toMatch(/READ ALOUD/i);
    expect(userPrompt()).toMatch(/read aloud|say verbatim/i);
    await collect(streamAnswer(baseInput({ format: 'technical' })));
    expect(userPrompt()).toMatch(/out loud|read aloud/i);
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

/** The framing split (docs/00-VISION.md): interviews are one mode, so the
 *  candidate persona must not follow the user into every other conversation. */
describe('answer framing', () => {
  const system = () => String((h.lastBody!.input as { role: string; content: string }[])[0].content);

  it('defaults to the interview framing, unchanged', async () => {
    await collect(streamAnswer(baseInput()));
    expect(system()).toContain('You ARE the candidate');
    expect(system()).toContain('while the interviewer watches');
    expect(userPrompt()).toContain('Interview type: behavioral');
    expect(userPrompt()).toContain('Candidate role target: SWE @ Acme');
  });

  it('conversation framing never casts the user as a candidate being assessed', async () => {
    await collect(streamAnswer(baseInput({ framing: 'conversation' })));
    const sys = system();
    expect(sys).not.toContain('candidate');
    expect(sys).not.toContain('interviewer');
    expect(sys).toContain('live conversation');
    // and it says so positively, not just by omission
    expect(sys).toMatch(/Nobody is assessing them/i);
  });

  it('conversation framing drops interview-only user-prompt lines', async () => {
    await collect(streamAnswer({ ...baseInput(), framing: 'conversation' }));
    const p = userPrompt();
    expect(p).not.toContain('Interview type:');
    expect(p).not.toContain('Candidate role target:');
  });

  it('keeps the shared rules under BOTH framings — speakable, human, cited, grounded', async () => {
    for (const framing of ['interview', 'conversation'] as const) {
      await collect(streamAnswer(baseInput({ framing })));
      const sys = system();
      expect(sys, framing).toMatch(/WRITE FOR THE EAR/i);
      expect(sys, framing).toMatch(/SOUND 100% HUMAN/i);
      expect(sys, framing).toMatch(/CITE YOUR SOURCES/i);
      expect(sys, framing).toMatch(/FABRICATION GUARD/i);
    }
  });

  it('the interview guard is the v1 text; the conversation guard forbids invented figures', async () => {
    await collect(streamAnswer(baseInput({ framing: 'interview' })));
    expect(system()).toContain(
      '- FABRICATION GUARD: if the context can\'t support what\'s asked, do NOT make it up. Begin\n' +
        '  the answer with "⚠", state in one short clause that it\'s not in their background, then\n' +
        '  pivot to a grounded, cited, transferable-skills framing (this is the riskWarning case).',
    );
    await collect(streamAnswer(baseInput({ framing: 'conversation' })));
    const sys = system();
    // Asked for a Q3 budget with no notes, the meeting answer used to state a
    // dollar figure. The rule now names the failure and what to do instead.
    expect(sys).toMatch(/NEVER produce a\s+plausible-sounding number or range/);
    expect(sys).toMatch(/not in their notes/);
    expect(sys).not.toMatch(/transferable-skills/);
  });

  it('with no context, the conversation prompt says so where the facts would be', async () => {
    await collect(streamAnswer({ ...baseInput({ framing: 'interview' }), contextChunks: [] }));
    expect(userPrompt()).toContain('CONTEXT:\n(no relevant profile context found)');
    await collect(streamAnswer({ ...baseInput({ framing: 'conversation' }), contextChunks: [] }));
    expect(userPrompt()).toMatch(/CONTEXT:\n\(NOTHING in this Space matches the question/);
    expect(userPrompt()).toMatch(/no figure, no status, no decision, no owner/);
  });

  it('the no-context risk line is framed for the room it is shown in', async () => {
    const interview = await collect(streamAnswer({ ...baseInput({ framing: 'interview' }), contextChunks: [] }));
    expect(interview.at(-1)).toEqual({ type: 'meta', riskWarning: 'No matching profile experience found.' });
    const meeting = await collect(streamAnswer({ ...baseInput({ framing: 'conversation' }), contextChunks: [] }));
    expect(meeting.at(-1)).toEqual({
      type: 'meta',
      riskWarning: 'Nothing in this Space covers this — the answer is not grounded.',
    });
  });
});

describe('streamAnswer — in-session history', () => {
  it('tells the model a short follow-up continues the last exchange', async () => {
    await collect(
      streamAnswer(
        baseInput({
          question: 'Well, what was your role there?',
          history: [{ role: 'asked', question: 'Tell me about your last project.', answer: 'The Acme migration…' }],
        }),
      ),
    );
    expect(userPrompt()).toMatch(/"there".*refer to the subject of the last answer/);
    expect(userPrompt()).toMatch(/never switch to a different project or example/);
  });

  it('adds the session-so-far block right before the QUESTION, heard and answered items labeled', async () => {
    await collect(
      streamAnswer(
        baseInput({
          history: [
            { role: 'heard', text: 'Let us start with the platform rewrite.' },
            { role: 'asked', question: 'Which database did you pick?', answer: 'Postgres, for the JSONB support.' },
          ],
        }),
      ),
    );
    const p = userPrompt();
    expect(p).toContain('EARLIER IN THIS CONVERSATION');
    expect(p).toContain('Heard: Let us start with the platform rewrite.');
    expect(p).toContain('Asked: Which database did you pick?\nYou answered: Postgres, for the JSONB support.');
    expect(p).toMatch(/Do NOT cite it/);
    expect(p.indexOf('EARLIER IN THIS CONVERSATION')).toBeLessThan(p.indexOf('QUESTION:'));
    // History is additive only: it must not displace the CONTEXT block.
    expect(p.indexOf('CONTEXT:')).toBeLessThan(p.indexOf('EARLIER IN THIS CONVERSATION'));
  });

  it("labels the user's own microphone turns as theirs, and remote turns as heard", async () => {
    await collect(
      streamAnswer(
        baseInput({
          history: [
            { role: 'heard', text: 'What about the timeline?' },
            { role: 'heard', text: 'I covered the timeline in my intro.', speaker: 'candidate' },
            { role: 'heard', text: 'Sure, the Q3 plan.', speaker: 'you' },
          ],
        }),
      ),
    );
    const p = userPrompt();
    expect(p).toContain('Heard: What about the timeline?');
    expect(p).toContain('You said: I covered the timeline in my intro.');
    expect(p).toContain('You said: Sure, the Q3 plan.');
  });

  it('leaves the prompt untouched when history is absent or empty', async () => {
    await collect(streamAnswer(baseInput()));
    const without = userPrompt();
    await collect(streamAnswer(baseInput({ history: [] })));
    expect(userPrompt()).toBe(without);
    expect(without).not.toContain('EARLIER IN THIS CONVERSATION');
  });
});
