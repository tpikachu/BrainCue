import { openai } from './client';
import { model } from './models';

const SYSTEM = `You anticipate interviewers. Given an interview QUESTION and the candidate's
ANSWER, predict the ONE follow-up the interviewer is most likely to ask next — the thing the
answer left most open: a claimed metric to probe, a decision's tradeoff, a "what would you do
differently", a deeper "how" behind a summary. Be specific to THIS answer, not generic.
Keep it under 20 words, phrased as the interviewer would say it.
Return JSON only: {"followup": "…"} — or {"followup": null} if no follow-up is likely
(e.g. the answer was complete small talk).`;

/**
 * Post-stream follow-up prediction (v1.5). Runs on the fast classify-tier model
 * AFTER the answer is done, so it can never touch first-token latency; the
 * result annotates the answer card ("Likely follow-up: …") and persists to
 * ai_answers.followup_question. Returns null when nothing useful is predicted.
 */
export async function predictFollowup(input: {
  question: string;
  answer: string;
  interviewType: string;
}): Promise<string | null> {
  const res = await openai().responses.create({
    model: model('classify'),
    input: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Interview type: ${input.interviewType}\n\n` +
          `QUESTION: ${input.question}\n\n` +
          `CANDIDATE'S ANSWER:\n${input.answer.slice(0, 4_000)}`,
      },
    ],
    text: { format: { type: 'json_object' } },
    max_output_tokens: 100,
  });
  try {
    const raw = JSON.parse(res.output_text) as { followup?: unknown };
    const f = typeof raw.followup === 'string' ? raw.followup.trim() : '';
    return f.length > 0 ? f : null;
  } catch {
    return null; // a malformed prediction is never worth surfacing an error for
  }
}
