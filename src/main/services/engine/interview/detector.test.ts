import { describe, expect, it, vi } from 'vitest';

vi.mock('../../openai/questions', () => ({ classifyQuestion: vi.fn() }));

import { detectQuestion, LATE_VERDICT_MAX_MS } from './detector';
import type { ClassifiedQuestion } from '../../openai/questions';

const yes = (confidence = 0.9, extra: Partial<ClassifiedQuestion> = {}) =>
  vi.fn(async (text: string) => ({ isQuestion: true, text, type: 'followup' as const, confidence, strategy: '', ...extra }));

describe('detectQuestion', () => {
  it('decides clear requests by rule, without calling the classifier', async () => {
    const classify = yes();
    const d = await detectQuestion('Walk me through that project.', { classify });
    expect(d).toMatchObject({ act: true, source: 'heuristic' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('hands ambiguous turns to the classifier with the recent context', async () => {
    const classify = yes(0.8);
    const recent = [{ speaker: 'interviewer' as const, text: 'Tell me about the migration.' }];
    const d = await detectQuestion('And your role', { classify, recent });
    expect(d).toMatchObject({ act: true, source: 'model' });
    expect(classify).toHaveBeenCalledWith('And your role', expect.objectContaining({ recent }));
  });

  it('applies the confidence floor to the model', async () => {
    const d = await detectQuestion('The scaling side', { classify: yes(0.2) });
    expect(d).toMatchObject({ act: false, reason: 'confidence-below-floor' });
  });

  it('falls back to the rule lean when the classifier throws (invalid JSON, auth, network)', async () => {
    const classify = vi.fn(async () => {
      throw new Error('not json');
    });
    expect(await detectQuestion('And your role', { classify })).toMatchObject({
      act: true,
      source: 'fallback',
      reason: 'classifier-error',
    });
    // No interrogative lean → the fallback stays silent rather than answering small talk.
    expect(await detectQuestion('We have a big team in Berlin and another one in Austin.', { classify })).toMatchObject({
      act: false,
      source: 'fallback',
    });
  });

  it('decides from the rule lean at the timeout, then aborts a classifier that never answers', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const classify = vi.fn(
      (_t: string, o: { signal?: AbortSignal }) =>
        new Promise<ClassifiedQuestion>(() => {
          signal = o.signal;
        }),
    );
    const p = detectQuestion('And your role', { classify, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const d = await p;
    expect(d).toMatchObject({ source: 'fallback', reason: 'classifier-timeout', act: true });
    expect(signal?.aborted).toBe(false); // still listening for a late verdict
    await vi.advanceTimersByTimeAsync(LATE_VERDICT_MAX_MS);
    expect(await d.late).toBeNull();
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('a slow "yes" arrives as a late verdict', async () => {
    vi.useFakeTimers();
    const classify = vi.fn(
      (text: string) =>
        new Promise<ClassifiedQuestion>((r) =>
          setTimeout(() => r({ isQuestion: true, text, type: 'followup', confidence: 0.9, strategy: '' }), 2500),
        ),
    );
    const p = detectQuestion('Say more about the ranking change.', { classify, timeoutMs: 1200 });
    await vi.advanceTimersByTimeAsync(1201);
    const d = await p;
    expect(d.act).toBe(false); // no rule lean
    await vi.advanceTimersByTimeAsync(1500);
    expect(await d.late).toMatchObject({ act: true, source: 'model' });
    vi.useRealTimers();
  });

  it('passes the model continuation verdict through', async () => {
    const d = await detectQuestion('the one at Stripe I mean', { classify: yes(0.9, { continuesPrevious: true }) });
    expect(d.continuesPrevious).toBe(true);
  });
});
