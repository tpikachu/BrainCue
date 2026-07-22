import { z } from 'zod';
import { providerFor } from '../../../providers/registry';
import { streamAnswer } from '../../openai/answer';
import { ground } from '../grounding';
import { AmbientTriggerPolicy } from '../trigger/ambientPolicy';
import type { AmbientDecision } from '../trigger/ambientPolicy';
import type { AmbientCard, AmbientCardContext, ModeDefinition } from '../modeDefinition';

/**
 * Meeting Copilot as a ModeDefinition — a CONFIGURATION over the shared
 * engine, not a fork. Quiet by default: finalized turns run the ambient
 * trigger (heuristics → salience classifier → deterministic gates); acted
 * decisions become cards. Direct asks ("summon") stream a grounded answer
 * through the same generate path the interview uses.
 *
 * Groundedness rules baked in here:
 *  - action/decision/question/warning card bodies QUOTE the transcript turn —
 *    the card can never claim more than was said;
 *  - owners/deadlines appear only when the trigger extracted them explicitly;
 *  - context cards only exist when retrieval found something relevant, carry
 *    their chunk provenance, and their generated body may use ONLY that
 *    context (enforced by prompt + schema; empty retrieval = no card).
 */

const contextCardSchema = z.object({
  relevant: z.boolean(),
  title: z.string().max(120).default(''),
  body: z.string().max(900).default(''),
});

const CONTEXT_SYSTEM = `You surface one short background card during a live meeting, using ONLY the provided context snippets.
Return STRICT JSON: {"relevant": boolean, "title": string, "body": string}.
- Use ONLY facts present in the snippets. No outside knowledge, no speculation.
- Cite snippets inline as [1], [2] matching their order.
- 2-4 short sentences max — this is a glanceable card, not a memo.
- If the snippets don't genuinely help with the turn, return {"relevant": false, "title": "", "body": ""}.`;

/** Quote-the-transcript card body for the deterministic kinds. */
function quotedBody(decision: AmbientDecision, turnText: string): string {
  const lines = [`> ${turnText.trim()}`];
  if (decision.owner) lines.push(`\n**Owner:** ${decision.owner}`);
  if (decision.deadline) lines.push(`\n**Deadline:** ${decision.deadline}`);
  return lines.join('\n');
}

async function buildCard(
  decision: AmbientDecision,
  ctx: AmbientCardContext,
): Promise<AmbientCard | null> {
  if (!decision.kind) return null;

  if (decision.kind !== 'context') {
    return {
      kind: decision.kind,
      title: decision.title,
      body: quotedBody(decision, ctx.turnText),
      meta: {
        confidence: decision.confidence,
        owner: decision.owner,
        deadline: decision.deadline,
        source: decision.usedClassifier ? 'classifier' : 'heuristic',
      },
      sourceRefs: [{ type: 'transcript', id: ctx.transcriptChunkId }],
    };
  }

  // Context card: only exists when retrieval finds something to stand on.
  const chunks = await ground(ctx.profileId, ctx.turnText, ctx.packId);
  if (chunks.length === 0) return null;
  const numbered = chunks
    .map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.content.slice(0, 500)}`)
    .join('\n\n');
  const raw = await providerFor('chat').json<unknown>({
    task: 'answer',
    system: CONTEXT_SYSTEM,
    user: `Context snippets:\n${numbered}\n\nMeeting turn:\n${ctx.turnText}`,
    maxOutputTokens: 300,
  });
  const parsed = contextCardSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.relevant || !parsed.data.body) return null;
  return {
    kind: 'context',
    title: parsed.data.title || decision.title,
    body: parsed.data.body,
    meta: { confidence: decision.confidence, source: 'classifier' },
    sourceRefs: [
      { type: 'transcript', id: ctx.transcriptChunkId },
      ...chunks.map((c) => ({ type: 'chunk', id: c.id })),
    ],
    contextChunks: chunks,
  };
}

export const meetingMode: ModeDefinition = {
  id: 'meeting',
  sources: ['mic', 'system', 'ask'],
  remoteSpeaker: 'them', // v2 vocabulary — meetings never had legacy rows
  // The Q&A trigger never fires in ambient modes (finalized turns route
  // through `ambient`); direct asks go through the summoned policy.
  trigger: { evaluate: async () => ({ act: false, kind: null, reason: 'ambient-mode' }) },
  allowedContributions: ['context', 'open_question', 'action_item', 'decision', 'warning', 'answer'],
  surfaces: ['overlay', 'report'],
  defaultPresence: 'quiet', // meetings hate interruptions
  reportStrategy: 'meeting_report',

  // Summoned answers reuse the shared grounded generator; meetings default to
  // plain explanation framing.
  generate(input) {
    return streamAnswer({
      question: input.question,
      contextChunks: input.contextChunks,
      memories: input.memories,
      profile: input.profile,
      format: input.settings.answerFormat,
      pronunciation: false, // spoken-cue pronunciation aids are an interview thing
      interviewType: 'general',
      signal: input.signal,
    });
  },

  ambient: {
    createPolicy: (presence) => new AmbientTriggerPolicy(presence),
    buildCard,
  },
};
