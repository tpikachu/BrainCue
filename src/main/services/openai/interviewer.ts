import { chatText } from './chatTask';
import type { InterviewType, Job, Profile } from '@shared/types';

export interface QaTurn {
  q: string;
  a: string;
}

function profileContext(p: Profile, job: Job | null): string {
  const parts: string[] = [];
  parts.push(`Role: ${job?.title || p.targetRole || 'unspecified'}`);
  const company = job?.company || p.targetCompany;
  if (company) parts.push(`Company: ${company}`);
  if (p.parsedResume) {
    parts.push(`Candidate skills: ${p.parsedResume.skills?.slice(0, 20).join(', ')}`);
    parts.push(`Projects: ${p.parsedResume.projects?.slice(0, 5).map((x) => x.name).join(', ')}`);
  } else if (p.resumeText) {
    parts.push(`Resume excerpt: ${p.resumeText.slice(0, 1500)}`);
  }
  if (job?.parsedJd) {
    parts.push(`Job focus areas: ${job.parsedJd.focusAreas?.slice(0, 10).join(', ')}`);
  } else if (job?.jdText) {
    parts.push(`Job description excerpt: ${job.jdText.slice(0, 1000)}`);
  }
  return parts.join('\n');
}

/**
 * Generate the interviewer's next question. Acts as a realistic interviewer for
 * the given interview type, uses the candidate's resume/JD for relevance, and
 * follows up on the previous answer when appropriate. Returns ONLY the question.
 */
export async function generateQuestion(
  profile: Profile,
  history: QaTurn[],
  job: Job | null = null,
  interviewType: InterviewType = 'general',
): Promise<string> {
  const system = `You are a professional interviewer conducting a ${interviewType.replace(
    '_',
    ' ',
  )} interview for the role below. Ask ONE concise, natural, spoken-style question at a time.
- Use the candidate's resume and the job description to ask relevant questions.
- If the candidate just answered, ask a thoughtful follow-up OR move to a new area.
- Vary topics; don't repeat questions already asked.
- Output ONLY the question text, no preamble, no numbering.`;

  const convo = history
    .map((t, i) => `Q${i + 1}: ${t.q}\nCandidate: ${t.a || '(no answer)'}`)
    .join('\n\n');

  const user = [
    profileContext(profile, job),
    '',
    history.length ? `Conversation so far:\n${convo}` : 'This is the first question.',
    '',
    'Ask the next question now.',
  ].join('\n');

  // Routed: runs on the provider the mock task resolves to (chatTask.ts).
  return chatText({ task: 'mock', system, user });
}
