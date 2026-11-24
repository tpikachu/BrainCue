import { classifyQuestion, type ClassifiedQuestion, type ClassifierTurn } from '../../openai/questions';
import { assessUtterance, type UtteranceAssessment } from './questionHeuristics';
import type { QuestionType } from '@shared/types';

/** The v1 gate, unchanged: a classifier-confirmed question needs at least
 *  this confidence to get an automatic answer. */
export const QUESTION_CONFIDENCE_FLOOR = 0.4;

/** How long the classifier may take before the heuristic fallback decides.
 *  Sized so detection stays inside the 1.5 s p95 target with a margin for
 *  the scheduler's own work; a slower provider loses the classifier's
 *  opinion on ambiguous turns rather than adding seconds to every answer. */
export const CLASSIFY_TIMEOUT_MS = 1200;

/** After the timeout the classifier keeps running this much longer. A
 *  verdict that arrives in that window can still answer the question —
 *  late, but not lost (measured live: provider round trips from a desktop
 *  run 1.1–3 s, so a hard cut at the timeout discarded every model opinion). */
export const LATE_VERDICT_MAX_MS = 5000;

export interface Detection {
  act: boolean;
  type: QuestionType;
  confidence: number;
  strategy: string;
  /** Who decided: a reliable rule, the model, or the rule fallback after the
   *  model failed or timed out. */
  source: 'heuristic' | 'model' | 'fallback';
  /** The rule or failure that decided — for logs and the eval. Never text. */
  reason: string;
  /** The model judged this utterance a continuation/correction of the
   *  previous question (split or revised). */
  continuesPrevious: boolean;
  /** Fallback after a TIMEOUT only: the model's verdict if it arrives within
   *  LATE_VERDICT_MAX_MS (null on error or cap). The scheduler may act on a
   *  late "yes" the fallback said "no" to. */
  late?: Promise<Detection | null>;
}

export interface DetectOptions {
  recent?: ClassifierTurn[];
  timeoutMs?: number;
  /** Injected for tests and the replay eval. */
  classify?: (text: string, opts: { recent?: ClassifierTurn[]; signal?: AbortSignal }) => Promise<ClassifiedQuestion>;
  /** Precomputed assessment (the scheduler already ran it). */
  assessment?: UtteranceAssessment;
}

class TimeoutError extends Error {}

/**
 * Interview question detection: deterministic rules where they are reliable,
 * the model where the utterance is genuinely ambiguous, and a bounded
 * fallback when the model is slow, unavailable, or returns garbage.
 *
 * Never throws — a detection failure must not wedge the pipeline. The
 * fallback answers only utterances with an interrogative lean, so a broken
 * classifier costs recall on the ambiguous tail, never a flood of answers to
 * small talk.
 */
export async function detectQuestion(text: string, opts: DetectOptions = {}): Promise<Detection> {
  const a = opts.assessment ?? assessUtterance(text);
  const decided = (act: boolean, source: Detection['source'], reason: string, confidence = a.confidence): Detection => ({
    act,
    type: a.type,
    confidence,
    strategy: '',
    source,
    reason,
    continuesPrevious: false,
  });

  if (a.verdict === 'question') return decided(true, 'heuristic', a.rule);
  if (a.verdict === 'not') return decided(false, 'heuristic', a.rule);

  // ambiguous (or a fragment whose hold expired): ask the model, bounded.
  const classify = opts.classify ?? classifyQuestion;
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS;
  const call = classify(text, { recent: opts.recent, signal: ctl.signal }).then(fromModel);
  // Never an unhandled rejection: the race below and the late path both
  // observe `call`, but either may not be awaited.
  call.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
      }),
    ]);
  } catch (e) {
    if (!(e instanceof TimeoutError)) {
      ctl.abort();
      return decided(a.leaning, 'fallback', 'classifier-error', a.leaning ? 0.5 : 0);
    }
    // Timed out: decide now from the rule lean, and keep listening for the
    // model a little longer — a late "yes" can still answer.
    let cap: ReturnType<typeof setTimeout> | undefined;
    const late = Promise.race([
      call,
      new Promise<null>((resolve) => {
        cap = setTimeout(() => {
          ctl.abort();
          resolve(null);
        }, Math.max(0, LATE_VERDICT_MAX_MS - timeoutMs));
      }),
    ])
      .catch(() => null)
      .finally(() => cap && clearTimeout(cap));
    return { ...decided(a.leaning, 'fallback', 'classifier-timeout', a.leaning ? 0.5 : 0), late };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fromModel(c: ClassifiedQuestion): Detection {
  const act = c.isQuestion && c.confidence >= QUESTION_CONFIDENCE_FLOOR;
  return {
    act,
    type: c.type,
    confidence: c.confidence,
    strategy: c.strategy,
    source: 'model',
    reason: act ? 'question-detected' : c.isQuestion ? 'confidence-below-floor' : 'not-a-question',
    continuesPrevious: !!c.continuesPrevious,
  };
}
