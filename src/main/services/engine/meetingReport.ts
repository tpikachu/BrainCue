import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { contributionsRepo } from '../../db/repositories/contributions.repo';
import { providerFor } from '../../providers/registry';
import type { MeetingReport } from '@shared/types';

/**
 * End-of-meeting report: summary, decisions, action items (owners/deadlines
 * only when explicit), and unresolved questions. Two grounding layers:
 *  1. the prompt forbids invention and the response is zod-validated;
 *  2. a DETERMINISTIC post-filter nulls any owner/deadline string that does
 *     not literally appear in the transcript — the model proposes, the
 *     transcript disposes.
 * Persisted as a `summary` contribution whose meta carries the structure, so
 * the report is reviewable (and its items editable) like any contribution.
 */

export const meetingReportSchema = z.object({
  summary: z.string(),
  decisions: z
    .array(z.object({ text: z.string(), owner: z.string().nullable().default(null) }))
    .default([]),
  actionItems: z
    .array(
      z.object({
        text: z.string(),
        owner: z.string().nullable().default(null),
        deadline: z.string().nullable().default(null),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]),
});

const SYSTEM = `You write the end-of-meeting report from a transcript and the cards BrainCue surfaced during the meeting. Return STRICT JSON:
{"summary": string, "decisions": [{"text","owner"}], "actionItems": [{"text","owner","deadline"}], "openQuestions": [string]}

Rules:
- Base EVERYTHING on the transcript. Never invent decisions, owners, or dates.
- "owner"/"deadline" ONLY when explicitly stated in the transcript (a name, "by Friday"); otherwise null. When in doubt: null.
- openQuestions = substantive questions raised but never answered.
- summary: 3-6 sentences, plain and factual.`;

/** Deterministic groundedness guard: an owner/deadline survives only if it
 *  literally appears in the transcript (case-insensitive). Exported for tests. */
export function groundReport(report: MeetingReport, transcriptText: string): MeetingReport {
  const hay = transcriptText.toLowerCase();
  const keep = (v: string | null): string | null =>
    v && hay.includes(v.toLowerCase()) ? v : null;
  return {
    summary: report.summary,
    decisions: report.decisions.map((d) => ({ text: d.text, owner: keep(d.owner) })),
    actionItems: report.actionItems.map((a) => ({
      text: a.text,
      owner: keep(a.owner),
      deadline: keep(a.deadline),
    })),
    openQuestions: report.openQuestions,
  };
}

/** Markdown body for the persisted report contribution (and the Cue Card). */
export function renderMeetingReport(r: MeetingReport): string {
  const lines: string[] = [r.summary.trim()];
  if (r.decisions.length) {
    lines.push('', '## Decisions');
    for (const d of r.decisions) lines.push(`- ${d.text}${d.owner ? ` — ${d.owner}` : ''}`);
  }
  if (r.actionItems.length) {
    lines.push('', '## Action items');
    for (const a of r.actionItems) {
      const extra = [a.owner, a.deadline].filter(Boolean).join(' · ');
      lines.push(`- ${a.text}${extra ? ` — ${extra}` : ''}`);
    }
  }
  if (r.openQuestions.length) {
    lines.push('', '## Open questions');
    for (const q of r.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join('\n');
}

function transcriptOf(sessionId: string): string {
  return db()
    .select()
    .from(schema.transcriptChunks)
    .where(eq(schema.transcriptChunks.sessionId, sessionId))
    .orderBy(asc(schema.transcriptChunks.createdAt))
    .all()
    .map((r) => `${r.speaker}: ${r.text}`)
    .join('\n');
}

function findExistingReport(sessionId: string) {
  return contributionsRepo
    .listBySession(sessionId)
    .find((c) => c.kind === 'summary' && (c.meta as { reportType?: string } | null)?.reportType === 'meeting');
}

/** The report plus its backing contribution id — edits go through
 *  contributions:update on that row. */
export interface MeetingReportHandle {
  contributionId: string;
  report: MeetingReport;
}

export async function generateMeetingReport(sessionId: string): Promise<MeetingReportHandle> {
  const transcript = transcriptOf(sessionId);
  const cards = contributionsRepo
    .listBySession(sessionId)
    .filter((c) => ['action_item', 'decision', 'open_question', 'context', 'warning'].includes(c.kind))
    .map((c) => `[${c.kind}] ${c.title ?? ''}: ${c.body}`)
    .join('\n');

  const raw = await providerFor('chat').json<unknown>({
    task: 'answer',
    system: SYSTEM,
    user: `Transcript:\n${transcript || '(empty)'}\n\nCards surfaced during the meeting:\n${cards || '(none)'}`,
    maxOutputTokens: 900,
  });
  const report = groundReport(meetingReportSchema.parse(raw), transcript);

  const existing = findExistingReport(sessionId);
  if (existing) {
    contributionsRepo.update(existing.id, {
      body: renderMeetingReport(report),
      meta: { reportType: 'meeting', report },
    });
    return { contributionId: existing.id, report };
  }
  const contributionId = crypto.randomUUID();
  db()
    .insert(schema.contributions)
    .values({
      id: contributionId,
      sessionId,
      kind: 'summary',
      status: 'completed',
      title: 'Meeting report',
      body: renderMeetingReport(report),
      meta: JSON.stringify({ reportType: 'meeting', report }),
      sourceRefs: null,
    })
    .run();
  return { contributionId, report };
}

/** Get-or-generate: the Sessions page calls this; stop() also fires it so the
 *  report is usually ready by the time the user looks. */
export async function getOrGenerateMeetingReport(sessionId: string): Promise<MeetingReportHandle> {
  const existing = findExistingReport(sessionId);
  if (existing) {
    const meta = existing.meta as { report?: MeetingReport } | null;
    if (meta?.report) return { contributionId: existing.id, report: meta.report };
  }
  return generateMeetingReport(sessionId);
}
