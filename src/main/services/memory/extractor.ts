import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { memoriesRepo } from '../../db/repositories/memories.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { checkSensitive } from './sensitiveFilter';
import type { MemoryItem } from '@shared/types';

/**
 * Post-session memory extraction — CONSERVATIVE by contract:
 *  - runs only after explicit consent (global switch, per-Space opt-out);
 *  - at most 5 candidates, each zod-validated, each below-floor one dropped;
 *  - anything the sensitive filter flags is REJECTED before persistence —
 *    secrets/payment/health/sensitive-personal content is never stored;
 *  - everything lands as status 'pending': nothing is remembered until the
 *    user approves it in the Memory section.
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
        /** Set ONLY for single-valued facts, so a new value can supersede the
         *  old one instead of coexisting with it (docs/14-MEMORY.md §4). The
         *  shape is enforced: a malformed key fails the whole candidate rather
         *  than being stored, because a wrong key retires a good memory. */
        factKey: z
          .string()
          .regex(/^[a-z0-9]+:[a-z0-9-]+\/[a-z0-9-]+$/)
          .max(80)
          .nullish(),
      }),
    )
    .max(5)
    .default([]),
});

const SYSTEM = `You extract AT MOST 5 durable memory candidates from a finished session transcript. Return STRICT JSON:
{"candidates": [{"category": "preference"|"person"|"project"|"goal"|"decision"|"fact"|"workflow"|"custom", "content": string, "scope": "profile"|"space", "confidence": 0..1, "importance": 0..1, "factKey": string|null}]}

A good candidate is something the USER would clearly want remembered next time: a stable preference, a recurring person, an ongoing project, a goal, a decision they made, a workflow. Write "content" as one self-contained sentence.

BE CONSERVATIVE:
- Fewer is better; return {"candidates": []} when nothing is clearly durable.
- NEVER include secrets, credentials, payment data, government IDs, health details, or sensitive personal attributes (religion, politics, orientation, immigration, criminal record) — not even paraphrased.
- scope "space" only when the fact is specific to THIS meeting/job context; otherwise "profile".
- confidence reflects how explicitly the transcript supports it. When in doubt, lower.

SET "factKey" ONLY for a fact that can have exactly ONE current value, so a later value replaces this one rather than sitting beside it. Format: "domain:subject/attribute", lowercase kebab — e.g. "project:atlas/launch-date", "person:sarah-chen/role", "profile:user/job-title". Same fact = same key across sessions, so choose the obvious slug and reuse it.
OMIT "factKey" (or null) for anything multi-valued or narrative: preferences, stories, workflows, observations. A wrong key silently retires a good memory, so when unsure, omit it.`;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Has the user already been asked about this exact claim?
 *
 * A recurring Space states the same facts every week — that is what makes it
 * recurring. Without this, week two re-proposes what week one approved, and the
 * review queue fills with the user's own past decisions; pressing Keep twice on
 * one session does the same thing in a single sitting. Both make the queue
 * something you stop reading, which is the only mechanism protecting memory
 * from garbage.
 *
 * Any STATUS counts, including rejected: the user has answered this sentence.
 * Re-asking is noise whichever way they answered, and the match is on exact
 * normalized text, so a genuinely different phrasing still gets through.
 *
 * Scope follows recall's rule: a profile-wide memory is already recalled inside
 * every Space, so it shadows a Space-scoped duplicate. A memory belonging to a
 * DIFFERENT Space shadows nothing — that Space's conversations never see it.
 */
function alreadyKnown(known: MemoryItem[], content: string, packId: string | null): boolean {
  const needle = normalize(content);
  return known.some(
    (m) => normalize(m.content) === needle && (m.packId == null || m.packId === packId),
  );
}

/** Extract + persist pending candidates for a finished session. Returns how
 *  many were saved (0 when consent is off, there is no Space to keep it in, the
 *  Space opted out, the session is too thin, nothing survived the gates, or
 *  everything was already known).
 *
 *  Note the scopes still differ: the session must belong to a Space, but a
 *  candidate the extractor marks `profile` is stored profile-wide and recalled
 *  everywhere. Where a conversation is kept and how far what it taught reaches
 *  are two different questions. */
export async function extractMemoryCandidates(sessionId: string): Promise<number> {
  if (settingsRepo.get(SETTINGS_KEYS.memoryEnabled) !== '1') return 0; // no capture before consent
  const session = db()
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!session) return 0;
  // A Space is where a conversation is kept — with none, this session is a
  // one-off and leaves nothing behind, the same rule the archive follows. It is
  // stated in the start modal and offered again at the save prompt, so "no
  // Space" is a choice the user made twice rather than something lost quietly.
  if (!session.packId) return 0;
  const pack = contextPacksRepo.get(session.packId);
  if (pack && !pack.memoryEnabled) return 0; // Space opted out

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

  // Everything this profile already has to say about, in any scope and any
  // state. Built once: the candidate set is at most 5 and this list is small.
  const known = memoriesRepo.list({ profileId: session.profileId });

  let saved = 0;
  for (const c of parsed.candidates) {
    if (c.confidence < MEMORY_CONFIDENCE_FLOOR) continue;
    if (checkSensitive(c.content).sensitive) continue; // hard privacy gate — never stored
    const packId = c.scope === 'space' ? session.packId : null;

    // ── Consolidation (docs/14-MEMORY.md §4) ──────────────────────────────
    // A keyed candidate is compared against the CURRENT value of that fact:
    //   identical   → the fact was restated, not changed. Stamp it as freshly
    //                 confirmed and store nothing.
    //   contradicts → fall through to a normal pending candidate. Approving it
    //                 is what supersedes the old value; the extractor never
    //                 retires anything on its own.
    const current = c.factKey
      ? memoriesRepo.currentByFactKey(session.profileId, packId, c.factKey)
      : null;
    if (current && normalize(current.content) === normalize(c.content)) {
      memoriesRepo.markUsed([current.id], Date.now()); // re-confirmed, not re-stored
      continue;
    }

    // The general guard still applies to everything, keyed or not: an exact
    // restatement the user has ALREADY answered (in any status) must not be
    // raised again. A keyed contradiction gets past it because its text
    // genuinely differs — which is the whole point.
    if (alreadyKnown(known, c.content, packId)) continue;

    const id = memoriesRepo.insertCandidate({
      profileId: session.profileId,
      packId,
      category: c.category,
      content: c.content,
      confidence: c.confidence,
      importance: c.importance,
      sourceRefs: [{ type: 'session', id: sessionId }],
      factKey: c.factKey ?? null,
      sourceKind: 'extracted',
    });
    // Within one extraction too: a model can repeat itself across candidates.
    known.push(memoriesRepo.get(id)!);
    saved += 1;
  }
  return saved;
}
