import { chatJson } from '../openai/chatTask';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { buildSparringReport } from '../mock/sparringManager';
import type { SessionReport } from '@shared/types';

const PROMPT = `You are an interview coach. Given the transcript and Q/A pairs,
produce JSON: { summary, strengths[], improvements[], perQuestion[{question,assessment}] }.
Be specific and constructive. Return JSON only.`;

/** Generate (and persist) a coaching report for a finished session. */
export async function generateReport(sessionId: string): Promise<SessionReport> {
  const detail = sessionsRepo.detail(sessionId);
  if (!detail) throw new Error('Session not found');

  // A sparring drill's coaching lives in answer_feedback (ai_answers is never
  // written), so the LLM generator below would fabricate an all-"(no answer)"
  // report. Assemble the local report instead — same output as end() produces.
  if (detail.kind === 'sparring') {
    const report = buildSparringReport(sessionId);
    if (!report) throw new Error('This practice drill has no coached answers to report on.');
    return report;
  }

  const transcript = detail.transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n');
  const qa = detail.questions
    .map((q) => `Q: ${q.text}\nA: ${q.answer?.directAnswer ?? '(no answer)'}`)
    .join('\n\n');

  // Routed: runs on the provider the answer task resolves to — the same one
  // that wrote this session's answers (chatTask.ts).
  const raw = await chatJson<Partial<SessionReport>>({
    task: 'answer',
    system: PROMPT,
    user: `TRANSCRIPT:\n${transcript}\n\nQ/A:\n${qa}`.slice(0, 24_000),
    maxOutputTokens: 8192,
  });
  return sessionsRepo.saveReport({
    sessionId,
    summary: raw.summary ?? '',
    strengths: raw.strengths ?? [],
    improvements: raw.improvements ?? [],
    perQuestion: raw.perQuestion ?? [],
  });
}
