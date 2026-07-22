import type {
  AnswerFormat,
  ContributionKind,
  InterviewType,
  Profile,
  RetrievedChunk,
  SessionMode,
  Speaker,
} from '@shared/types';
import type { AnswerEvent } from '../openai/answer';
import type { TriggerPolicy } from './trigger/triggerPolicy';

/**
 * Per-session runtime settings the user can flip live from the Cue Card.
 * Interview-shaped today (the only shipped mode); becomes a per-mode bag when
 * new modes bring their own dials (sensitivity, presence, …).
 */
export interface RuntimeSettings {
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
}

export interface GenerateInput {
  question: string;
  contextChunks: RetrievedChunk[];
  profile: Profile;
  settings: RuntimeSettings;
  signal: AbortSignal;
}

/**
 * A mode is CONFIGURATION over the one engine — never a fork of the pipeline.
 * It declares what the engine may do (sources, contribution kinds, surfaces),
 * when to act (trigger policy), and how to speak (generate/persona). The
 * engine owns all flow, concurrency, persistence, and broadcasting; a mode
 * that needs something the engine can't express extends the engine.
 */
export interface ModeDefinition {
  id: SessionMode;
  sources: readonly ('mic' | 'system' | 'ask' | 'screen' | 'clipboard')[];
  /** Speaker label persisted + broadcast for remote finalized turns. Interview
   *  keeps the legacy 'interviewer' so rows and the Cue Card are unchanged;
   *  new modes use the v2 vocabulary ('them'). */
  remoteSpeaker: Speaker;
  /** When should an automatic contribution happen? (Direct asks bypass this —
   *  the engine routes them through the summoned policy.) */
  trigger: TriggerPolicy;
  allowedContributions: readonly ContributionKind[];
  surfaces: readonly ('overlay' | 'voice' | 'report')[];
  /** Presence dials become user-tunable with the ambient modes; a mode's
   *  default documents its posture. */
  defaultPresence: 'summoned' | 'quiet' | 'balanced' | 'active';
  /** Which report generator runs at session end (report service key). */
  reportStrategy: string;
  /** Stream one contribution's content (the persona lives in here). Yields the
   *  shared AnswerEvent contract (delta / meta / usage). */
  generate(input: GenerateInput): AsyncGenerator<AnswerEvent>;
  /** Optional post-completion prediction (interview: the likely follow-up).
   *  The ENGINE owns the staleness guards around persisting the result. */
  predictFollowup?(input: {
    question: string;
    answer: string;
    settings: RuntimeSettings;
  }): Promise<string | null>;
}
