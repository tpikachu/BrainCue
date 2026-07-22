import type { ComponentType } from 'react';
import type { CardModel } from './model';
import { ActionItemCardView } from './ActionItemCardView';
import { AnswerCardView } from './AnswerCardView';
import { CodeCardView } from './CodeCardView';
import { ContextCardView } from './ContextCardView';
import { DecisionCardView } from './DecisionCardView';
import { MemoryCardView } from './MemoryCardView';
import { OpenQuestionCardView } from './OpenQuestionCardView';
import { SuggestedQuestionCardView } from './SuggestedQuestionCardView';
import { SummaryCardView } from './SummaryCardView';
import { UnknownCardView } from './UnknownCardView';
import { WarningCardView } from './WarningCardView';

/** What a card of this kind can DO — explicit capabilities the shell renders
 *  actions from, instead of per-kind flag checks scattered through the JSX. */
export interface CardCapabilities {
  /** Copy the card body (pronunciation-stripped) to the clipboard. */
  copy: boolean;
  /** The per-card ↻ button: its tooltip, or false to hide it. The handler is
   *  uniform (try the session pipeline, fall back to a re-solve) — only the
   *  affordance is per-kind. */
  regenerate: { tooltip: string } | false;
  /** Memory cards: correct/forget the underlying memory (meta.memoryId) right
   *  from the card. Handlers come from the shell; only the affordance is here. */
  memory?: boolean;
}

export interface CardViewProps {
  card: CardModel;
  /** True for the newest card (drives the empty-state placeholder). */
  isCurrent: boolean;
  live: boolean;
  paused: boolean;
  /** Expanded citation key (`${cardId}:${n}`) — lifted so only one is open. */
  openCite: string | null;
  onToggleCite: (k: string | null) => void;
}

export interface CardDefinition {
  capabilities: CardCapabilities;
  /** Small chip shown before the title for non-Q&A kinds; null = the v1
   *  "Q:" prefix (answer/code cards render exactly as before). */
  chip: string | null;
  View: ComponentType<CardViewProps>;
}

const noActions: CardCapabilities = { copy: true, regenerate: false };

/** One entry per ContributionKind. `coverage` and `tutor_prompt` share the
 *  closest view until their modes land — the kind is still first-class on the
 *  card and the wire. */
const DEFINITIONS: Record<string, CardDefinition> = {
  answer: {
    capabilities: { copy: true, regenerate: { tooltip: 'Regenerate this answer' } },
    chip: null,
    View: AnswerCardView,
  },
  code: {
    capabilities: { copy: true, regenerate: { tooltip: 'Re-solve this problem' } },
    chip: null,
    View: CodeCardView,
  },
  context: { capabilities: noActions, chip: 'Context', View: ContextCardView },
  action_item: { capabilities: noActions, chip: 'Action item', View: ActionItemCardView },
  open_question: { capabilities: noActions, chip: 'Open question', View: OpenQuestionCardView },
  suggested_question: {
    capabilities: noActions,
    chip: 'Suggested question',
    View: SuggestedQuestionCardView,
  },
  coverage: { capabilities: noActions, chip: 'Coverage', View: SummaryCardView },
  warning: { capabilities: { ...noActions, copy: false }, chip: 'Warning', View: WarningCardView },
  decision: { capabilities: noActions, chip: 'Decision', View: DecisionCardView },
  tutor_prompt: { capabilities: noActions, chip: 'Tutor', View: SuggestedQuestionCardView },
  memory_suggestion: {
    capabilities: { ...noActions, memory: true }, // correct/forget from the card
    chip: 'Memory',
    View: MemoryCardView,
  },
  summary: { capabilities: noActions, chip: 'Summary', View: SummaryCardView },
};

/** Fallback for kinds this build doesn't know: render, never crash. */
const UNKNOWN: CardDefinition = {
  capabilities: { copy: true, regenerate: false },
  chip: null, // chip text comes from the raw kind at the call site
  View: UnknownCardView,
};

export function cardDefinition(kind: string): CardDefinition {
  return DEFINITIONS[kind] ?? UNKNOWN;
}

export function isKnownKind(kind: string): boolean {
  return kind in DEFINITIONS;
}
