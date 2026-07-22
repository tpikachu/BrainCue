import { z } from 'zod';
import { providerFor } from '../../../providers/registry';

/**
 * Step 2 of the ambient trigger architecture: the structured salience
 * classifier, called ONLY for turns the deterministic heuristics found
 * ambiguous. The result is zod-validated — an unparsable or failed response
 * is SILENCE, never a guess (the default posture prefers silence over a
 * low-confidence interruption).
 */

export const salienceSchema = z.object({
  salient: z.boolean(),
  kind: z.enum(['context', 'open_question', 'action_item', 'decision', 'warning']).nullable(),
  confidence: z.number().min(0).max(1),
  /** Short card title, quoting or tightly paraphrasing the turn. */
  title: z.string().max(200).default(''),
  /** ONLY when explicitly named in the turn — else null. */
  owner: z.string().nullable().default(null),
  /** ONLY when explicitly stated in the turn — else null. */
  deadline: z.string().nullable().default(null),
});

export type SalienceResult = z.infer<typeof salienceSchema>;

const SYSTEM = `You watch one turn of a live meeting and decide if BrainCue should quietly surface a card. Return STRICT JSON:
{"salient": boolean, "kind": "context"|"open_question"|"action_item"|"decision"|"warning"|null, "confidence": 0..1, "title": string, "owner": string|null, "deadline": string|null}

Kinds:
- "context": the turn references a topic where background from the user's documents would genuinely help.
- "open_question": a substantive question was raised that is going unanswered.
- "action_item": someone committed to doing something.
- "decision": the group settled a choice.
- "warning": the turn plainly contradicts something said earlier or carries a clear risk. Use sparingly.

Rules:
- "owner"/"deadline" ONLY if EXPLICITLY stated in the turn, verbatim or near-verbatim. Never infer.
- Meetings hate interruptions: when unsure, return {"salient": false, "kind": null, "confidence": 0, "title": "", "owner": null, "deadline": null}.`;

export type SalienceClassifier = (
  turn: string,
  recentTurns: string[],
) => Promise<SalienceResult | null>;

export const classifySalience: SalienceClassifier = async (turn, recentTurns) => {
  try {
    const raw = await providerFor('chat').json<unknown>({
      task: 'classify',
      system: SYSTEM,
      user: `Recent turns:\n${recentTurns.map((t) => `- ${t}`).join('\n') || '- (none)'}\n\nCurrent turn:\n${turn}`,
      maxOutputTokens: 160,
    });
    const parsed = salienceSchema.safeParse(raw);
    return parsed.success ? parsed.data : null; // invalid shape → silence
  } catch {
    return null; // classifier failure → silence
  }
};
