import type {
  AnswerFormat,
  ContributionKind,
  InterviewType,
  Presence,
  Profile,
  RetrievedChunk,
  SessionMode,
  Speaker,
} from '@shared/types';
import type { AnswerEvent } from '../openai/answer';
import type { TriggerPolicy } from './trigger/triggerPolicy';
import type { AmbientDecision, AmbientTriggerPolicy } from './trigger/ambientPolicy';

/**
 * Per-session runtime settings the user can flip live from the Cue Card.
 * Interview-shaped today plus the ambient presence dial; becomes a per-mode
 * bag when more modes bring their own dials.
 */
export interface RuntimeSettings {
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
  /** Ambient posture (Meeting; later Companion). Interview ignores it. */
  presence: Presence;
}

export interface GenerateInput {
  question: string;
  contextChunks: RetrievedChunk[];
  profile: Profile;
  settings: RuntimeSettings;
  signal: AbortSignal;
}

/** One ambient card, ready to persist + broadcast. Built by the mode from an
 *  acted trigger decision; the ENGINE owns persistence and emission. */
export interface AmbientCard {
  kind: ContributionKind;
  title: string;
  body: string;
  meta: Record<string, unknown> | null;
  sourceRefs: { type: string; id: string }[];
  /** Retrieved grounding, when the card used it — surfaced in "data sent". */
  contextChunks?: RetrievedChunk[];
}

export interface AmbientCardContext {
  turnText: string;
  transcriptChunkId: string;
  profileId: string;
  packId: string | null;
}

/** The ambient capability: modes that quietly contribute on their own
 *  (Meeting; later Companion). The policy instance holds per-session state
 *  (cooldowns, dedupe, pending questions), so it's CREATED per session. */
export interface AmbientMode {
  createPolicy(presence: Presence): AmbientTriggerPolicy;
  /** Turn an acted decision into a concrete card, or null for silence (e.g.
   *  a context card whose retrieval found nothing relevant). */
  buildCard(decision: AmbientDecision, ctx: AmbientCardContext): Promise<AmbientCard | null>;
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
  /** Ambient contribution capability (Meeting). When present, finalized turns
   *  route through the ambient policy instead of the Q&A trigger — direct
   *  asks still stream answers through `generate`. */
  ambient?: AmbientMode;
}
