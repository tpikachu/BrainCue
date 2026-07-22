import { AnswerCardView } from './AnswerCardView';
import type { CardViewProps } from './registry';

/** A coding solve streams the same markdown body as an answer (fenced code +
 *  the four-beat delivery); what differs is its actions — regenerate re-solves
 *  the problem instead of re-running the session pipeline — and those live in
 *  the registry capabilities, not here. */
export function CodeCardView(props: CardViewProps) {
  return <AnswerCardView {...props} />;
}
