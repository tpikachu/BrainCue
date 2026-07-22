import { z } from 'zod';
import { providerFor } from '../../../providers/registry';

/**
 * The companion's salience classifier — called ONLY for turns the
 * deterministic heuristics found ambiguous, and ONLY after the cheap policy
 * gates (mute, presence, DND, budget, global cooldown) already passed, so
 * silence and cooldown windows never spend a model call. Zod-validated;
 * unparsable or failed responses are SILENCE, never a guess.
 */

export const companionSalienceSchema = z.object({
  salient: z.boolean(),
  kind: z
    .enum(['memory_suggestion', 'context', 'action_item', 'suggested_question'])
    .nullable(),
  confidence: z.number().min(0).max(1),
  /** How strongly the turn relates to the user's documents/memory/Space. */
  relevance: z.number().min(0).max(1),
  /** Short card title (for suggested_question: the question itself). */
  title: z.string().max(200).default(''),
});

export type CompanionSalienceResult = z.infer<typeof companionSalienceSchema>;

export type CompanionSalienceClassifier = (
  turn: string,
  recentTurns: string[],
  activeContext: string | null,
) => Promise<CompanionSalienceResult | null>;

const SYSTEM = `You watch one spoken turn of a user working with an ambient companion and decide if it should quietly surface a card. Return STRICT JSON:
{"salient": boolean, "kind": "memory_suggestion"|"context"|"action_item"|"suggested_question"|null, "confidence": 0..1, "relevance": 0..1, "title": string}

Kinds:
- "memory_suggestion": the turn strongly relates to something the user previously saved as a memory.
- "context": background from the user's documents/Space would genuinely help right now.
- "action_item": the user committed to (or asked to be reminded of) a task.
- "suggested_question": ONE clarifying question would genuinely unblock the user. Use sparingly.

Rules:
- "relevance" scores how strongly the turn ties to the user's own material (documents, Space, memories) — not general interest.
- The user is WORKING; interruptions are expensive. When unsure, return {"salient": false, "kind": null, "confidence": 0, "relevance": 0, "title": ""}.`;

export const classifyCompanionSalience: CompanionSalienceClassifier = async (
  turn,
  recentTurns,
  activeContext,
) => {
  try {
    const raw = await providerFor('chat').json<unknown>({
      task: 'classify',
      system: SYSTEM,
      user: [
        `Recent turns:\n${recentTurns.map((t) => `- ${t}`).join('\n') || '- (none)'}`,
        // The active-app/context seam: included only when the host reported it.
        ...(activeContext ? [`Active context: ${activeContext}`] : []),
        `Current turn:\n${turn}`,
      ].join('\n\n'),
      maxOutputTokens: 160,
    });
    const parsed = companionSalienceSchema.safeParse(raw);
    return parsed.success ? parsed.data : null; // invalid shape → silence
  } catch {
    return null; // classifier failure → silence
  }
};
