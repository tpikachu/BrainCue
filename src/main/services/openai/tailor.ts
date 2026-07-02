import { openai } from './client';
import { model, reasoningParam } from './models';
import type { ApplicationAnswer } from '@shared/types';

export interface TailorInput {
  /** The candidate's real resume text (profile resume or an uploaded file). */
  baseResume: string;
  jdText: string;
  /** Application questions to answer (may be empty). */
  questions: string[];
}

/** What the single tailoring call produces. */
export interface TailorResult {
  candidateName: string; // extracted from the base resume
  jobTitle: string; // extracted from the JD
  company: string; // extracted from the JD ('' when absent)
  tailoredResume: string; // ATS-friendly markdown
  answers: ApplicationAnswer[];
}

const SYSTEM = `You are an expert resume writer and career coach. You are given a candidate's
REAL resume (the only source of truth about them), a job description, and optional
application questions. Return JSON only, with keys:

- candidateName: the candidate's name as written on the resume ("" if absent).
- jobTitle: the job title, extracted from the JD ("" if unclear).
- company: the hiring company name, extracted from the JD ("" if unclear).
- tailoredResume: the resume rewritten to TARGET THIS JOB, as clean markdown.
- answers: one { "question", "answer" } object per application question, in order.

TAILORING RULES (the resume):
- GROUND EVERYTHING in the base resume. NEVER invent employers, titles, dates, degrees,
  projects, metrics, or skills the candidate doesn't have. You may reword, reorder,
  emphasize, quantify only with numbers already present, and trim what's irrelevant.
- Mirror the JD's language TRUTHFULLY: where the candidate genuinely has a skill the JD
  asks for, use the JD's exact keywords for it (ATS keyword matching). Skills the
  candidate lacks are simply omitted — never added.
- ATS-FRIENDLY structure, as markdown: name on the first line as an H1; one contact line
  (only details present in the base resume); then standard sections in this order, each an
  H2 — Summary, Skills, Experience, Education (plus Certifications/Projects only if the
  base resume has them). Experience entries: a bold "Role — Company" line, a plain date
  line if dates exist, then 3-6 achievement bullets (strongest, most JD-relevant first).
- Single column, plain text only: no tables, no images, no columns, no icons, no emoji.
- Concise: aim for the content of a 1-2 page resume. Cut filler, keep impact.

ANSWER RULES (the application questions):
- Answer AS the candidate, first person, grounded ONLY in the base resume (plus honest
  motivation/fit reasoning from the JD). Never invent experience. 60-150 words each,
  natural and human — no corporate filler, no "As an AI".
- If a question can't be answered from their background, be honest and pivot to the
  closest real, transferable experience.`;

/**
 * One call tailors the resume + answers the application questions + extracts the
 * job title/company. Output is defensively defaulted so a malformed model response
 * can't crash the handler — and nothing is persisted unless this call succeeds.
 */
export async function tailorApplication(input: TailorInput): Promise<TailorResult> {
  const user = [
    'BASE RESUME (the only source of truth about the candidate):',
    input.baseResume.slice(0, 24_000),
    '',
    'JOB DESCRIPTION:',
    input.jdText.slice(0, 24_000),
    '',
    input.questions.length
      ? `APPLICATION QUESTIONS:\n${input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : 'APPLICATION QUESTIONS: (none)',
    '',
    'Produce the JSON now.',
  ].join('\n');

  const res = await openai().responses.create({
    model: model('tailor'),
    ...reasoningParam('tailor'),
    input: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_object' } },
  });

  const raw = JSON.parse(res.output_text) as Partial<TailorResult> & { answers?: unknown };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const answers: ApplicationAnswer[] = (Array.isArray(raw.answers) ? (raw.answers as unknown[]) : [])
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return { question: str(o.question), answer: str(o.answer) };
    })
    .filter((a) => a.question && a.answer);

  const tailoredResume = str(raw.tailoredResume);
  if (!tailoredResume) throw new Error('Tailoring failed — the model returned no resume.');

  return {
    candidateName: str(raw.candidateName),
    jobTitle: str(raw.jobTitle),
    company: str(raw.company),
    tailoredResume,
    answers,
  };
}
