import { z } from 'zod';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../../ipc/broadcast';
import { providerFor } from '../../../providers/registry';
import { SETTINGS_KEYS, settingsRepo } from '../../../db/repositories/settings.repo';
import { contextPacksRepo } from '../../../db/repositories/jobs.repo';
import { recallMemories } from '../../memory/recall';
import { streamQuickAnswer } from '../../voice/quickAnswer';
import { ground } from '../grounding';
import { CostMeter } from '../companion/costMeter';
import { InterjectionPolicy } from '../trigger/interjectionPolicy';
import { isCompanionPresence } from '../trigger/companionPresence';
import {
  buildPersonaPreamble,
  DEFAULT_COMPANION_PREFS,
  mergePersonality,
} from '../persona';
import type {
  CompanionPersonality,
  CompanionPrefs,
  CompanionPresence,
  CompanionStatusEvent,
} from '@shared/types';
import type { AmbientDecision } from '../trigger/ambientPolicy';
import type {
  AmbientCard,
  AmbientCardContext,
  AmbientSessionContext,
  ModeDefinition,
} from '../modeDefinition';

/**
 * Companion mode — an EXPLICITLY started ambient session (no background
 * listening before consent: the session, and with it the microphone, exists
 * only after the user starts it). A ModeDefinition over the shared engine:
 * finalized turns run the InterjectionPolicy engine (every automatic
 * contribution passes its deterministic gates); direct summons stream a
 * persona-voiced grounded answer.
 *
 * Groundedness rules baked in here:
 *  - task cards QUOTE the user's own words; clarifying-question cards carry
 *    the quoted turn under the question;
 *  - memory cards surface only APPROVED memory, show WHY it was recalled
 *    (the matched turn + score), and carry the memory id so the overlay can
 *    correct/forget it in place;
 *  - context cards exist only when retrieval found something, may use ONLY
 *    that context, and carry chunk provenance.
 *
 * One live session at a time (engine invariant), so per-session state lives
 * at module level — createPolicy resets it (same pattern as mockManager).
 */

/** Memory cards need a genuinely strong tie, not just "past the recall gate". */
const MEMORY_CARD_FLOOR = 0.45;

interface CompanionSessionState {
  sessionId: string;
  meter: CostMeter;
  policy: InterjectionPolicy;
  personality: CompanionPersonality;
}

let live: CompanionSessionState | null = null;

export function readCompanionPrefs(): CompanionPrefs {
  const stored = settingsRepo.getJson<Partial<CompanionPrefs>>(SETTINGS_KEYS.companionPrefs, {});
  return {
    ...DEFAULT_COMPANION_PREFS,
    ...stored,
    personality: { ...DEFAULT_COMPANION_PREFS.personality, ...(stored.personality ?? {}) },
  };
}

function broadcastStatus(state: CompanionSessionState): void {
  broadcast(EVENTS.companionStatus, {
    sessionId: state.sessionId,
    presence: state.policy.currentPresence,
    cost: state.meter.snapshot(),
  } satisfies CompanionStatusEvent);
}

function createPolicy(_enginePresence: string, ctx: AmbientSessionContext): InterjectionPolicy {
  const prefs = readCompanionPrefs();
  const overrides = ctx.packId ? contextPacksRepo.get(ctx.packId)?.companionPrefs : null;
  // The engine's Presence dial is a coarse projection (COMPANION_TO_ENGINE_
  // PRESENCE at start) — the policy's OWN posture is the richer companion
  // vocabulary. Precedence: the explicit start-time choice, then the Space
  // override, then the global default.
  const presence: CompanionPresence =
    ctx.companionPresence && isCompanionPresence(ctx.companionPresence)
      ? ctx.companionPresence
      : (overrides?.presence ?? prefs.presence);
  const budgetCents = ctx.budgetCents !== undefined ? ctx.budgetCents : prefs.budgetCents;

  // The onChange closures capture `state`, which is fully assigned before any
  // model call can fire — meter first, then the policy that carries it.
  const state = { sessionId: ctx.sessionId } as CompanionSessionState;
  state.meter = new CostMeter({ budgetCents, onChange: () => broadcastStatus(state) });
  state.policy = new InterjectionPolicy({
    presence,
    dnd: prefs.dnd,
    meter: state.meter,
    onPresenceChange: () => broadcastStatus(state),
  });
  state.personality = mergePersonality(prefs.personality, overrides);
  live = state;
  broadcastStatus(state); // seed the Cue Card's companion bar immediately
  return state.policy;
}

const contextCardSchema = z.object({
  relevant: z.boolean(),
  title: z.string().max(120).default(''),
  body: z.string().max(900).default(''),
});

const CONTEXT_SYSTEM = `You surface one short background card for a user working alongside an ambient companion, using ONLY the provided context snippets.
Return STRICT JSON: {"relevant": boolean, "title": string, "body": string}.
- Use ONLY facts present in the snippets. No outside knowledge, no speculation.
- Cite snippets inline as [1], [2] matching their order.
- 2-4 short sentences max — this is a glanceable card, not a memo.
- If the snippets don't genuinely help with the turn, return {"relevant": false, "title": "", "body": ""}.`;

async function buildCard(
  decision: AmbientDecision,
  ctx: AmbientCardContext,
): Promise<AmbientCard | null> {
  if (!decision.kind) return null;

  // Task flag: quote the user's own words — the card claims nothing more.
  if (decision.kind === 'action_item') {
    return {
      kind: 'action_item',
      title: decision.title,
      body: `> ${ctx.turnText.trim()}`,
      meta: {
        confidence: decision.confidence,
        source: decision.usedClassifier ? 'classifier' : 'heuristic',
      },
      sourceRefs: [{ type: 'transcript', id: ctx.transcriptChunkId }],
    };
  }

  // Clarifying question: the question IS the title; the quoted turn grounds it.
  if (decision.kind === 'suggested_question') {
    return {
      kind: 'suggested_question',
      title: decision.title,
      body: `> ${ctx.turnText.trim()}`,
      meta: { confidence: decision.confidence, source: 'classifier' },
      sourceRefs: [{ type: 'transcript', id: ctx.transcriptChunkId }],
    };
  }

  // Remembered fact: only APPROVED memory (recall enforces status+consent),
  // re-gated on the ACTUAL semantic score — the classifier only suspected a
  // tie; the vector decides. No model call at all.
  if (decision.kind === 'memory_suggestion') {
    const memories = await recallMemories(ctx.profileId, ctx.turnText, ctx.packId);
    const top = memories[0];
    if (!top || top.score < MEMORY_CARD_FLOOR) return null;
    return {
      kind: 'memory_suggestion',
      title: 'You saved this',
      body: top.content,
      meta: {
        memoryId: top.id, // the overlay's correct/forget actions target this
        category: top.category,
        score: Math.round(top.score * 100) / 100,
        // WHY this surfaced — shown on the card verbatim.
        why: `Matched what you just said: “${ctx.turnText.trim().slice(0, 140)}”`,
      },
      sourceRefs: [
        { type: 'memory', id: top.id },
        { type: 'transcript', id: ctx.transcriptChunkId },
      ],
    };
  }

  // Context card: only exists when retrieval finds something to stand on.
  const chunks = await ground(ctx.profileId, ctx.turnText, ctx.packId);
  if (chunks.length === 0) return null;
  const numbered = chunks
    .map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.content.slice(0, 500)}`)
    .join('\n\n');
  live?.meter.noteCall('card');
  const raw = await providerFor('chat').json<unknown>({
    task: 'answer',
    system: CONTEXT_SYSTEM,
    user: `Context snippets:\n${numbered}\n\nWhat the user said:\n${ctx.turnText}`,
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

export const companionMode: ModeDefinition = {
  id: 'companion',
  sources: ['mic', 'ask'],
  remoteSpeaker: 'you', // the companion listens to the USER
  // The Q&A trigger never fires in ambient modes (finalized turns route
  // through `ambient`); direct asks go through the summoned policy.
  trigger: { evaluate: async () => ({ act: false, kind: null, reason: 'ambient-mode' }) },
  allowedContributions: [
    'memory_suggestion',
    'context',
    'action_item',
    'suggested_question',
    'answer',
  ],
  surfaces: ['overlay', 'voice'],
  // Engine-level dial (coarse); the policy's CompanionPresence is the real
  // posture and comes from prefs/per-Space overrides in createPolicy.
  defaultPresence: 'summoned',
  reportStrategy: 'none',

  // Summons speak with the persona — the ONE persona source (engine/persona.ts)
  // prepended to the shared quick-answer generator.
  generate(input) {
    live?.meter.noteCall('answer');
    return streamQuickAnswer({
      question: input.question,
      contextChunks: input.contextChunks,
      memories: input.memories,
      personaPreamble: buildPersonaPreamble(live?.personality ?? readCompanionPrefs().personality),
      signal: input.signal,
    });
  },

  ambient: { createPolicy, buildCard },
};
