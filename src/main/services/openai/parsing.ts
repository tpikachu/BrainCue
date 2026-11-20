import { chatJson } from './chatTask';
import type { ParsedCompany, ParsedJd, ParsedResume } from '@shared/types';

// NOTE (skeleton): these use the Responses API with a JSON instruction. Swap to
// strict structured outputs (json_schema) when wiring M1. Output is parsed and
// defensively defaulted so a malformed model response can't crash callers.

const RESUME_PROMPT = `Extract a structured candidate profile as JSON with keys:
skills[], projects[{name,description,impact}], workHistory[{company,role,period,highlights[]}],
metrics[], education[], certifications[], techStack[], leadership[].
Only use information present in the resume. Return JSON only.`;

const JD_PROMPT = `Extract the job description as JSON with keys:
requirements[], responsibilities[], keywords[], focusAreas[]. Return JSON only.`;

const COMPANY_PROMPT = `You are researching a company from text scraped off its
website, to help a candidate interview well. Extract JSON with keys:
overview (1-3 sentence what-they-do summary, string),
products[] (main products/services),
techStack[] (technologies/tools they mention, if any),
values[] (stated company values/mission points),
culture[] (notes on work culture / what they look for),
recentNews[] (recent launches, milestones, or initiatives mentioned),
interviewAngles[] (concrete ways a candidate could tailor answers to this company).
Only use information present in the text; leave arrays empty if unknown. Return JSON only.`;

async function extractJson<T>(systemPrompt: string, text: string): Promise<T> {
  // Routed: runs on the provider the parsing task resolves to (chatTask.ts).
  return chatJson<T>({ task: 'parsing', system: systemPrompt, user: text.slice(0, 24_000), maxOutputTokens: 8192 });
}

export async function parseResume(text: string): Promise<ParsedResume> {
  const raw = await extractJson<Partial<ParsedResume>>(RESUME_PROMPT, text);
  return {
    skills: raw.skills ?? [],
    projects: raw.projects ?? [],
    workHistory: raw.workHistory ?? [],
    metrics: raw.metrics ?? [],
    education: raw.education ?? [],
    certifications: raw.certifications ?? [],
    techStack: raw.techStack ?? [],
    leadership: raw.leadership ?? [],
  };
}

export async function parseJobDescription(text: string): Promise<ParsedJd> {
  const raw = await extractJson<Partial<ParsedJd>>(JD_PROMPT, text);
  return {
    requirements: raw.requirements ?? [],
    responsibilities: raw.responsibilities ?? [],
    keywords: raw.keywords ?? [],
    focusAreas: raw.focusAreas ?? [],
  };
}

export async function parseCompany(text: string): Promise<ParsedCompany> {
  const raw = await extractJson<Partial<ParsedCompany>>(COMPANY_PROMPT, text);
  return {
    overview: raw.overview ?? '',
    products: raw.products ?? [],
    techStack: raw.techStack ?? [],
    values: raw.values ?? [],
    culture: raw.culture ?? [],
    recentNews: raw.recentNews ?? [],
    interviewAngles: raw.interviewAngles ?? [],
  };
}
