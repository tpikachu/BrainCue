import { chatJson } from './chatTask';
import type { ParsedResume, StoryCompetency, StoryDraft } from '@shared/types';

/** Closed competency set the extractor may tag stories with. Keep in sync with
 *  the StoryCompetency union in @shared/types. A closed set keeps tags
 *  consistent + filterable (no free-form tag pollution). */
export const COMPETENCIES: StoryCompetency[] = [
  'leadership',
  'teamwork',
  'conflict',
  'failure',
  'ambiguity',
  'impact',
  'technical_depth',
  'communication',
  'ownership',
  'problem_solving',
  'growth',
  'customer_focus',
];
const COMPETENCY_SET = new Set<string>(COMPETENCIES);

export interface StoriesInput {
  targetRole: string;
  resume: ParsedResume;
  /** Raw résumé text (richer than the parsed structure for narrative detail). */
  resumeText: string | null;
}

const SYSTEM = `You are an interview-prep coach building a candidate's reusable STAR story bank.
From their résumé ONLY, extract 4–8 distinct, reusable STAR stories — concrete accomplishments
they can retell to answer behavioral/experience questions. Return JSON only: { "stories": [ ... ] }
where each story is:

- title: a short handle for the story (≤ 8 words), e.g. "Cut checkout latency 40%".
- situation: the context/problem (1–2 sentences, first person: "I…").
- task: what they were responsible for (1 sentence).
- action: the specific actions THEY took (2–3 sentences, concrete).
- result: the outcome, with real numbers/metrics FROM THE RÉSUMÉ where present (1–2 sentences).
- competencies: 1–3 tags drawn ONLY from this exact set:
  ${COMPETENCIES.join(', ')}.
- skills: specific technologies/skills the story demonstrates (drawn from the résumé).

RULES:
- GROUND EVERYTHING in the résumé. Never invent employers, projects, metrics, or outcomes that
  aren't supported by it. If a metric isn't in the résumé, describe the result qualitatively
  rather than fabricating a number.
- Prefer DISTINCT stories that cover a RANGE of competencies (don't return five leadership
  stories). Pick the strongest, most reusable accomplishments.
- Write in the candidate's first-person voice. Be specific and terse.
- If the résumé is thin, return fewer stories rather than padding with weak/invented ones.`;

/**
 * Extract grounded STAR stories from the candidate's parsed résumé (+ raw text).
 * Output is defensively defaulted, competencies are clamped to the closed set,
 * and malformed/empty stories are dropped — a bad model response can't crash callers.
 */
export async function generateStories(input: StoriesInput): Promise<StoryDraft[]> {
  const payload = JSON.stringify({
    targetRole: input.targetRole,
    resume: input.resume,
    resumeText: input.resumeText ?? undefined,
  });

  // Routed: runs on the provider the parsing task resolves to (chatTask.ts).
  const raw = await chatJson<{ stories?: unknown }>({
    task: 'parsing',
    system: SYSTEM,
    user: payload.slice(0, 24_000),
    maxOutputTokens: 8192,
  });
  const stories = Array.isArray(raw.stories) ? raw.stories : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  return stories
    .map((s): StoryDraft => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        title: str(o.title),
        situation: str(o.situation),
        task: str(o.task),
        action: str(o.action),
        result: str(o.result),
        competencies: Array.isArray(o.competencies)
          ? (o.competencies.filter((c): c is StoryCompetency => COMPETENCY_SET.has(c as string)) as StoryCompetency[])
          : [],
        skills: Array.isArray(o.skills) ? o.skills.filter((k): k is string => typeof k === 'string') : [],
      };
    })
    // Keep only stories with enough substance to be useful.
    .filter((s) => s.title && s.situation && s.action && s.result);
}
