import type { CompanionCost } from '@shared/types';

/**
 * Cost governance for ambient sessions: counts every model call, accumulates
 * token usage where the transport reports it, and keeps a deterministic
 * cents ESTIMATE — visibility and budget gating, not billing. The estimate is
 * intentionally conservative flat rates per call class (documented below);
 * when real usage arrives it is added on top of the per-call floor.
 */

/** Flat per-call estimate floors, in cents. Classify-tier calls are tiny;
 *  card/answer generations are budgeted like a short completion. */
const CALL_CENTS: Record<CostCallClass, number> = {
  classify: 0.05,
  card: 0.2,
  answer: 0.5,
  embedding: 0.01,
};

/** Rough token pricing for the usage-reported part (cents per 1K tokens,
 *  blended prompt/completion at mini-tier rates). */
const CENTS_PER_1K_TOKENS = 0.05;

export type CostCallClass = 'classify' | 'card' | 'answer' | 'embedding';

export class CostMeter {
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private flatCents = 0;
  private warnedFlag = false;
  readonly budgetCents: number | null;
  private readonly warnRatio: number;
  private readonly onChange?: (snapshot: CompanionCost) => void;

  constructor(opts: {
    budgetCents: number | null;
    warnRatio?: number;
    onChange?: (snapshot: CompanionCost) => void;
  }) {
    this.budgetCents = opts.budgetCents;
    this.warnRatio = opts.warnRatio ?? 0.8;
    this.onChange = opts.onChange;
  }

  /** Record one model call (with usage when the transport reported it). */
  noteCall(cls: CostCallClass, usage?: { prompt: number; completion: number }): void {
    this.calls += 1;
    this.flatCents += CALL_CENTS[cls];
    if (usage) {
      this.promptTokens += usage.prompt;
      this.completionTokens += usage.completion;
    }
    this.onChange?.(this.snapshot());
  }

  estCents(): number {
    const tokenCents = ((this.promptTokens + this.completionTokens) / 1000) * CENTS_PER_1K_TOKENS;
    return Math.round((this.flatCents + tokenCents) * 100) / 100;
  }

  /** True once the estimate crosses warnRatio × budget. Latches. */
  warned(): boolean {
    if (this.budgetCents !== null && this.estCents() >= this.budgetCents * this.warnRatio) {
      this.warnedFlag = true;
    }
    return this.warnedFlag;
  }

  /** Hard budget reached — the interjection policy silences ambient work. */
  exhausted(): boolean {
    return this.budgetCents !== null && this.estCents() >= this.budgetCents;
  }

  snapshot(): CompanionCost {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      estCents: this.estCents(),
      budgetCents: this.budgetCents,
      warned: this.warned(),
      exhausted: this.exhausted(),
    };
  }
}
