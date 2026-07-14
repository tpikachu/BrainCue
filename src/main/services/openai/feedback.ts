import { openai } from './client';
import { model } from './models';
import { COMPETENCIES } from './stories';
import type { InterviewType, Job, Profile, SparringFeedback, StoryCompetency } from '@shared/types';

export interface FeedbackInput {
  question: string;
  /** The candidate's transcribed spoken answer. */
  answer: string;
  profile: Profile;
  job: Job | null;
  interviewType: InterviewType;
}

function context(p: Profile, job: Job | null): string {
  const parts: string[] = [`Role: ${job?.title || p.targetRole || 'unspecified'}`];
  const company = job?.company || p.targetCompany;
  if (company) parts.push(`Company: ${company}`);
  if (p.parsedResume) {
    parts.push(`Candidate skills: ${p.parsedResume.skills?.slice(0, 20).join(', ')}`);
    parts.push(`Projects: ${p.parsedResume.projects?.slice(0, 6).map((x) => x.name).join(', ')}`);
    if (p.parsedResume.metrics?.length) parts.push(`Metrics: ${p.parsedResume.metrics.slice(0, 8).join('; ')}`);
  } else if (p.resumeText) {
    parts.push(`Resume excerpt: ${p.resumeText.slice(0, 1500)}`);
  }
  if (job?.parsedJd) parts.push(`Job focus: ${job.parsedJd.focusAreas?.slice(0, 10).join(', ')}`);
  return parts.join('\n');
}

const SYSTEM = `You are a sharp, supportive interview coach evaluating a candidate's SPOKEN answer
to an interview question (the answer is a speech-to-text transcript, so ignore minor
disfluencies/transcription noise — judge the substance). Return JSON only:

- verdict: one honest sentence on how the answer landed.
- rating: integer 1–5 (1 = weak/off-topic, 3 = solid, 5 = excellent, specific, well-structured).
- strengths: 1–3 concrete things the answer did well (specific to what they actually said).
- improvements: 1–3 concrete, actionable fixes for next time (structure, specificity, a missing
  metric/result, STAR framing, relevance to the role).
- tip: ONE actionable pointer — ideally name a real project/skill/metric FROM THEIR RÉSUMÉ they
  could have used to strengthen the answer.
- competency: the ONE competency the QUESTION primarily probes, chosen from exactly this list:
  ${COMPETENCIES.join(', ')}. (Used to chart practice progress per competency.)

Be specific and constructive. Judge ONLY what they actually said against the question. Never
invent experience or claim they said things they didn't. If the answer is empty or off-topic,
say so plainly and rate it low.`;

/**
 * Evaluate one spoken answer and return structured coaching feedback. Output is
 * defensively defaulted and the rating is clamped to 1–5 so a malformed model
 * response can't crash the Sparring turn loop.
 */
export async function evaluateAnswer(input: FeedbackInput): Promise<SparringFeedback> {
  const user = [
    context(input.profile, input.job),
    `Interview type: ${input.interviewType}`,
    '',
    `QUESTION: ${input.question}`,
    '',
    `CANDIDATE'S SPOKEN ANSWER: ${input.answer.trim() || '(no answer captured)'}`,
    '',
    'Evaluate the answer now.',
  ].join('\n');

  const res = await openai().responses.create({
    model: model('mock'),
    input: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_object' } },
  });

  const raw = JSON.parse(res.output_text) as Partial<SparringFeedback>;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const ratingNum = Math.round(Number(raw.rating));
  const rating = Number.isFinite(ratingNum) ? Math.min(5, Math.max(1, ratingNum)) : 3;
  // Closed-set validation — an off-list competency degrades to null, never junk.
  const competency = (COMPETENCIES as readonly string[]).includes(raw.competency as string)
    ? (raw.competency as StoryCompetency)
    : null;

  return {
    verdict: typeof raw.verdict === 'string' ? raw.verdict : '',
    rating,
    strengths: strs(raw.strengths),
    improvements: strs(raw.improvements),
    tip: typeof raw.tip === 'string' ? raw.tip : '',
    competency,
  };
}
