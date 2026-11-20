import { chatJson } from './chatTask';
import type { InterviewBrief, ParsedCompany, ParsedJd, ParsedResume } from '@shared/types';

export interface BriefInput {
  targetRole: string;
  company: string | null;
  resume: ParsedResume;
  jd: ParsedJd;
  /** Parsed company research, when the interview has a researched company site. */
  companyResearch: ParsedCompany | null;
}

const SYSTEM = `You are an interview-prep coach. Given a candidate's parsed résumé, the
target job's parsed JD, and (optionally) parsed company research, produce a concise
PRE-INTERVIEW BRIEF the candidate can study before the call. Return JSON only, with keys:

- summary: 1–2 sentences framing what THIS interview will most likely probe.
- likelyQuestions: 6–10 items [{question, why}] — the most probable questions given the
  role + JD, MOST likely first. "why" is a one-line rationale tied to a specific JD
  requirement/responsibility or a résumé item.
- gaps: JD requirements with weak résumé coverage as
  [{requirement, coverage, howToAddress}] where coverage is exactly "strong", "partial",
  or "missing". "howToAddress" is one concrete line on how to bridge it (a transferable
  story, what to study, or how to be honest about it). Focus on partial/missing items.
- strengths: 3–6 résumé highlights that map STRONGLY to the JD as [{point, evidence}],
  where "evidence" is the specific résumé item (project, metric, role) backing it.
- companyAngles: concrete ways to tailor answers to this company, drawn from the company
  research (values, products, recent news). Empty if no company research is provided.

Ground EVERYTHING only in the provided data — never invent the candidate's experience,
employers, metrics, or company facts. If the data is thin, return fewer items rather than
fabricating. Be specific and terse; no preamble.`;

/**
 * Generate a grounded pre-interview brief from the candidate's parsed résumé,
 * the job's parsed JD, and any parsed company research. Output is defensively
 * defaulted so a malformed model response can't crash callers.
 */
export async function generateBrief(input: BriefInput): Promise<InterviewBrief> {
  const payload = JSON.stringify({
    targetRole: input.targetRole,
    company: input.company,
    resume: input.resume,
    jobDescription: input.jd,
    companyResearch: input.companyResearch,
  });

  // Routed: runs on the provider the parsing task resolves to (chatTask.ts).
  const raw = await chatJson<Partial<InterviewBrief>>({
    task: 'parsing',
    system: SYSTEM,
    user: payload.slice(0, 24_000),
    maxOutputTokens: 8192,
  });
  const coverage = (v: unknown): 'strong' | 'partial' | 'missing' =>
    v === 'strong' || v === 'missing' ? v : 'partial';

  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    likelyQuestions: (raw.likelyQuestions ?? [])
      .filter((q) => q && typeof q.question === 'string')
      .map((q) => ({ question: q.question, why: typeof q.why === 'string' ? q.why : '' })),
    gaps: (raw.gaps ?? [])
      .filter((g) => g && typeof g.requirement === 'string')
      .map((g) => ({
        requirement: g.requirement,
        coverage: coverage(g.coverage),
        howToAddress: typeof g.howToAddress === 'string' ? g.howToAddress : '',
      })),
    strengths: (raw.strengths ?? [])
      .filter((s) => s && typeof s.point === 'string')
      .map((s) => ({ point: s.point, evidence: typeof s.evidence === 'string' ? s.evidence : '' })),
    companyAngles: (raw.companyAngles ?? []).filter((a): a is string => typeof a === 'string'),
  };
}
