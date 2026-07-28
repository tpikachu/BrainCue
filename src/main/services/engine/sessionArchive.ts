import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { providerFor } from '../../providers/registry';
import { assertEmbeddingCompatibility } from '../rag/embeddingIdentity';
import { chunkText } from '../rag/chunker';
import { vectorToBuffer } from '../rag/vectorMath';
import { checkSensitive } from '../memory/sensitiveFilter';

/**
 * Session archive — the thing that makes BrainCue continuous
 * (docs/16-CONTINUITY.md).
 *
 * Before this, a finished conversation left a transcript that nothing could
 * retrieve: `session_reports` were generated and stored, then read only by the
 * Sessions page. Every call therefore started from zero, and "what did we agree
 * three calls ago" was unanswerable — fine for a one-off interview, fatal for a
 * companion that sits in your daily calls.
 *
 * At stop, each session is distilled into a short archive and indexed as
 * `session` chunks, so later conversations ground in earlier ones through the
 * retrieval path that already exists.
 *
 * How this differs from memory, deliberately:
 *  - **Memory** extracts standing claims about the *person* ("prefers concise
 *    answers"), so it is consent-gated OFF and every item is reviewed.
 *  - **An archive** is a summary of a conversation the user chose to run, drawn
 *    from a transcript already stored on their disk. It is scoped to where the
 *    conversation happened and never becomes a claim about them, so it defaults
 *    ON — but it honours the same per-Space opt-out, runs the same sensitive
 *    filter before persistence, and is deleted with its session.
 */

/** Below this, there was no conversation to archive. */
const MIN_TURNS = 4;
/** Transcript sent to the summariser. Beyond this the tail is dropped, which
 *  is acceptable here in a way it is not for ingest: the end of a call is
 *  where the decisions are, so we keep the END, not the beginning. */
const MAX_TRANSCRIPT_CHARS = 24_000;
const ARCHIVE_CHUNK_CHARS = 700;
/** Verbatim lines kept alongside the summary. A handful: enough that the
 *  archive can be quoted back, few enough that it stays a summary. */
const MAX_QUOTES = 6;

export const archiveSchema = z.object({
  /** One line naming what this conversation was, for retrieval to match on. */
  topic: z.string().min(3).max(160),
  /** 1-3 sentences of what actually happened. */
  summary: z.string().min(10).max(800),
  decisions: z.array(z.string().min(3).max(300)).max(8).default([]),
  /** "Owner — what they committed to", owner omitted when unclear. */
  actionItems: z.array(z.string().min(3).max(300)).max(10).default([]),
  openQuestions: z.array(z.string().min(3).max(300)).max(6).default([]),
  /** People/companies/projects the conversation was about. */
  participants: z.array(z.string().min(2).max(80)).max(10).default([]),
  /**
   * Lines copied VERBATIM out of the transcript — the actual words, not the
   * model's reading of them. Text only: who said each one is looked up from
   * the transcript row it matches (`attributeQuotes`), so a quote can never be
   * put in the wrong person's mouth.
   */
  keyQuotes: z.array(z.string().min(8).max(400)).max(MAX_QUOTES).default([]),
});

export type SessionArchive = z.infer<typeof archiveSchema>;

const SYSTEM = `You write the archive entry for a conversation that just ended, so that WEEKS LATER someone can retrieve it and know what happened without re-reading the transcript.

Return STRICT JSON:
{"topic": string, "summary": string, "decisions": string[], "actionItems": string[], "openQuestions": string[], "participants": string[]}

RULES:
- "topic" names the conversation the way the user would search for it later ("Acme renewal pricing", "Tuesday standup — Atlas migration"). Not "Meeting" or "Discussion".
- "summary" is 1-3 sentences of what actually happened. Write it self-contained: name the people, projects, and numbers rather than saying "they" or "the client".
- "decisions" are things that were SETTLED. "actionItems" are commitments someone made — lead with the owner when the transcript names one ("Sarah Chen — send the revised quote by Friday"). "openQuestions" are things raised and left unresolved.
- Empty arrays are a correct answer. Do not manufacture decisions or action items that were not made; an archive that invents commitments is worse than no archive.
- NEVER include secrets, credentials, payment data, government IDs, health details, or sensitive personal attributes — not even paraphrased.
- "participants" are the named people, companies, projects, or products the conversation was about. Omit generic references ("the client", "our team").
- "keyQuotes" are up to 6 lines COPIED CHARACTER-FOR-CHARACTER from the transcript — the sentences that carry the commitment, the number, the decision, or the objection. Do not paraphrase, correct, translate, merge, or trim them; do not include the speaker label. A line that is not present verbatim in the transcript will be discarded. Prefer few and exact over many and approximate.`;

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Transcript speaker labels are engine vocabulary; an archive read weeks later
 *  is prose. An unknown label passes through rather than being flattened, so a
 *  future speaker id (diarisation) needs no change here. */
const SPEAKER_LABEL: Record<string, string> = {
  you: 'You',
  them: 'They',
  candidate: 'You',
  interviewer: 'Interviewer',
  agent: 'BrainCue',
  unknown: 'Someone',
};

export interface AttributedQuote {
  speaker: string;
  text: string;
}

/**
 * Keep only the "quotes" that are genuinely in the transcript, and attribute
 * each from the row it matched.
 *
 * A summariser asked for verbatim lines will still occasionally smooth one, and
 * an archive that fabricates a quote is worse than one with no quotes at all —
 * the entire point of keeping the words is that they can be trusted as the
 * words. Attribution comes from the matched ROW rather than from the model, so
 * a quote cannot be put in the wrong person's mouth even when the model is
 * confused about who was speaking.
 */
export function attributeQuotes(
  quotes: string[],
  turns: { speaker: string; text: string }[],
): AttributedQuote[] {
  const haystack = turns.map((t) => ({ speaker: t.speaker, norm: norm(t.text) }));
  const out: AttributedQuote[] = [];
  const seen = new Set<string>();
  for (const quote of quotes) {
    const needle = norm(quote);
    if (!needle || seen.has(needle)) continue;
    const row = haystack.find((h) => h.norm.includes(needle));
    if (!row) continue; // not actually said — drop it
    seen.add(needle);
    out.push({ speaker: SPEAKER_LABEL[row.speaker] ?? row.speaker, text: quote.trim() });
  }
  return out;
}

/** The archive rendered as retrievable text. One coherent block, because the
 *  pieces only make sense together — a bare action item retrieved without its
 *  topic is not usable context. The verified verbatim lines ride along, so a
 *  later conversation can quote what was actually said and not only what the
 *  call was about. */
export function renderArchive(
  a: SessionArchive,
  when: number,
  quotes: AttributedQuote[] = [],
): string {
  const date = new Date(when).toISOString().slice(0, 10);
  const lines = [`Conversation on ${date} — ${a.topic}.`, a.summary];
  if (a.participants.length) lines.push(`Who: ${a.participants.join(', ')}.`);
  if (a.decisions.length) lines.push(`Decided: ${a.decisions.join('; ')}.`);
  if (a.actionItems.length) lines.push(`Action items: ${a.actionItems.join('; ')}.`);
  if (a.openQuestions.length) lines.push(`Still open: ${a.openQuestions.join('; ')}.`);
  if (quotes.length)
    lines.push(['In their own words:', ...quotes.map((q) => `${q.speaker}: “${q.text}”`)].join('\n'));
  return lines.join('\n\n');
}

/**
 * Summarise a finished session and index it for retrieval. Returns how many
 * chunks were written (0 whenever it declined — consent off, Space opted out,
 * too short, or the model failed).
 *
 * Never throws: this runs fire-and-forget after a session ends, and a failed
 * archive must not surface as a broken session.
 */
export async function archiveSession(sessionId: string): Promise<number> {
  try {
    if (settingsRepo.get(SETTINGS_KEYS.sessionArchiveEnabled) === '0') return 0;

    const session = db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) return 0;
    // Practice drills are rehearsals against an AI, not conversations that
    // happened — archiving them would pollute recall with invented scenarios.
    if (session.mode === 'practice' || session.kind === 'mock' || session.kind === 'sparring') {
      return 0;
    }
    if (session.packId) {
      const pack = contextPacksRepo.get(session.packId);
      if (pack && !pack.memoryEnabled) return 0; // the Space opted out of remembering
    }

    const turns = db()
      .select()
      .from(schema.transcriptChunks)
      .where(eq(schema.transcriptChunks.sessionId, sessionId))
      .orderBy(asc(schema.transcriptChunks.createdAt))
      .all();
    if (turns.length < MIN_TURNS) return 0;

    const full = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    // Keep the END of a long call: that is where decisions and commitments land.
    const transcript =
      full.length > MAX_TRANSCRIPT_CHARS ? full.slice(-MAX_TRANSCRIPT_CHARS) : full;

    const raw = await providerFor('chat').json<unknown>({
      task: 'parsing',
      system: SYSTEM,
      user: `Transcript:\n${transcript}`,
      maxOutputTokens: 900,
    });
    const parsed = archiveSchema.safeParse(raw);
    if (!parsed.success) return 0; // unusable shape → archive nothing

    const quotes = attributeQuotes(parsed.data.keyQuotes, turns);
    const text = renderArchive(parsed.data, session.endedAt ?? session.createdAt, quotes);
    // The privacy gate applies here exactly as it does to memory: a summary can
    // repeat a credential someone read aloud, and an archive is retrievable.
    if (checkSensitive(text).sensitive) return 0;

    const pieces = chunkText(text, ARCHIVE_CHUNK_CHARS);
    if (pieces.length === 0) return 0;

    const embedding = providerFor('embedding');
    const identity = embedding.identity();
    assertEmbeddingCompatibility(identity); // one embedding space per database
    // Embed BEFORE writing: a provider failure leaves no half-indexed archive.
    const vectors = await embedding.embed(pieces.map((p) => p.content));

    sessionsRepo.deleteArchive(sessionId); // re-archiving replaces, never duplicates
    for (const [i, piece] of pieces.entries()) {
      const chunkId = crypto.randomUUID();
      db()
        .insert(schema.chunks)
        .values({
          id: chunkId,
          profileId: session.profileId,
          // Scoped to where the conversation happened: a Space-bound call stays
          // inside that Space, so one client's history can never ground another
          // client's meeting. Unscoped sessions archive globally, which is what
          // makes a personal companion continuous across the day.
          packId: session.packId,
          sourceType: 'session',
          sourceId: sessionId,
          ord: piece.ord,
          content: piece.content,
        })
        .run();
      const vector = vectors[i];
      if (!vector) continue;
      db()
        .insert(schema.embeddings)
        .values({
          id: crypto.randomUUID(),
          chunkId,
          provider: identity.provider,
          model: identity.model,
          dim: vector.length,
          vector: vectorToBuffer(vector),
        })
        .run();
    }
    return pieces.length;
  } catch {
    return 0; // an archive must never break the end of a session
  }
}
