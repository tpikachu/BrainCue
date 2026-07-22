import { providerFor } from '../../providers/registry';
import type { QuestionType } from '@shared/types';

export interface ClassifiedQuestion {
  isQuestion: boolean;
  text: string;
  type: QuestionType;
  confidence: number;
  strategy: string;
}

const PROMPT = `Classify the interviewer utterance. Return JSON:
{ "isQuestion": boolean, "type": one of
  ["behavioral","resume_project","technical_concept","coding","system_design","product","followup","salary_availability","clarification"],
  "confidence": 0..1, "strategy": short answer-strategy hint }.
If it is not actually a question, set isQuestion=false.`;

export async function classifyQuestion(text: string): Promise<ClassifiedQuestion> {
  const raw = await providerFor('chat').json<Partial<ClassifiedQuestion>>({
    task: 'classify',
    system: PROMPT,
    user: text,
  });
  return {
    isQuestion: raw.isQuestion ?? false,
    text,
    type: (raw.type as QuestionType) ?? 'behavioral',
    confidence: raw.confidence ?? 0,
    strategy: raw.strategy ?? '',
  };
}
