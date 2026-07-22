import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { checkSensitive } from './sensitiveFilter';

/**
 * Post-session memory extraction — CONSERVATIVE by contract:
 *  - runs only after explicit consent (global switch, per-Space opt-out);
 *  - at most 5 candidates, each zod-validated, each below-floor one dropped;
 *  - anything the sensitive filter flags is REJECTED before persistence —
 *    secrets/payment/health/sensitive-personal content is never stored;
 *  - everything lands as status 'pending': nothing is remembered until the
 *    user approves it in Library › Memory.
 */

export const MEMORY_CONFIDENCE_FLOOR = 0.6;

export const extractionSchema = z.object({
  candidates: z
    .array(
      z.object({
        category: z.enum([
          'preference',
          'person',
          'project',
          'goal',
          'decision',
          'fact',
          'workflow',
          'custom',
        ]),
        content: z.string().min(8).max(400),
        scope: z.enum(['profile', 'space']).default('profile'),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(5)
    .default([]),
});

const SYSTEM = `You extract AT MOST 5 durable memory candidates from a finished session transcript. Return STRICT JSON:
{"candidates": [{"category": "preference"|"person"|"project"|"goal"|"decision"|"fact"|"workflow"|"custom", "content": string, "scope": "profile"|"space", "confidence": 0..1, "importance": 0..1}]}

A good candidate is something the USER would clearly want remembered next time: a stable preference, a recurring person, an ongoing project, a goal, a decision they made, a workflow. Write "content" as one self-contained sentence.

BE CONSERVATIVE:
- Fewer is better; return {"candidates": []} when nothing is clearly durable.
- NEVER include secrets, credentials, payment data, government IDs, health details, or sensitive personal attributes (religion, politics, orientation, immigration, criminal record) — not even paraphrased.
- scope "space" only when the fact is specific to THIS meeting/job context; otherwise "profile".
- confidence reflects how explicitly the transcript supports it. When in doubt, lower.`;

/** Extract + persist pending candidates for a finished session. Returns how
 *  many were saved (0 when consent is off, the Space opted out, the session
 *  is too thin, or nothing survived the gates). */
export async function extractMemoryCandidates(sessionId: string): Promise<number> {
  if (settingsRepo.get(SETTINGS_KEYS.memoryEnabled) !== '1') return 0; // no capture before consent
  const session = db()
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!session) return 0;
  if (session.packId) {
    const pack = contextPacksRepo.get(session.packId);
    if (pack && !pack.memoryEnabled) return 0; // Space opted out
  }

  const turns = db()
    .select()
    .from(schema.transcriptChunks)
    .where(eq(schema.transcriptChunks.sessionId, sessionId))
    .orderBy(asc(schema.transcriptChunks.createdAt))
    .all();
  if (turns.length < 2) return 0; // nothing durable comes out of a one-liner

  const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
  let parsed: z.infer<typeof extractionSchema>;
  try {
    const raw = await providerFor('chat').json<unknown>({
      task: 'parsing',
      system: SYSTEM,
      user: `Transcript:\n${transcript}`,
      maxOutputTokens: 600,
    });
    const result = extractionSchema.safeParse(raw);
    if (!result.success) return 0; // invalid shape → extract nothing
    parsed = result.data;
  } catch {
    return 0; // extraction failure → nothing (never a partial guess)
  }

  let saved = 0;
  for (const c of parsed.candidates) {
    if (c.confidence < MEMORY_CONFIDENCE_FLOOR) continue;
    if (checkSensitive(c.content).sensitive) continue; // hard privacy gate — never stored
    memoriesRepo.insertCandidate({
      profileId: session.profileId,
      packId: c.scope === 'space' ? session.packId : null,
      category: c.category,
      content: c.content,
      confidence: c.confidence,
      importance: c.importance,
      sourceRefs: [{ type: 'session', id: sessionId }],
    });
    saved += 1;
  }
  return saved;
}
