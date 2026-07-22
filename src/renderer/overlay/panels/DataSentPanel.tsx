import type { ContextSentEvent } from '@shared/types';
import { ChevronRightIcon } from '../../components/icons';
import { noDrag } from '../lib/style';

/** Transparency: exactly what was sent to the provider for the focused card.
 *  `show` is lifted to the shell so the expanded state survives the panel
 *  unmounting between questions (context is empty until retrieval runs). */
export function DataSentPanel(props: {
  context: ContextSentEvent;
  show: boolean;
  onToggle: () => void;
}) {
  const { context, show } = props;
  return (
    <div className="mt-2 shrink-0 text-[11px]" style={noDrag}>
      <button
        onClick={props.onToggle}
        className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-300"
      >
        <ChevronRightIcon className={`h-3 w-3 transition-transform ${show ? 'rotate-90' : ''}`} />
        Data sent to OpenAI ({context.chunks.length} chunks)
      </button>
      {show && (
        <div className="mt-1 max-h-28 space-y-1 overflow-auto rounded bg-neutral-950/60 p-2 text-neutral-400">
          {context.chunks.length === 0 ? (
            <p>No profile context matched — answer is general/transferable.</p>
          ) : (
            context.chunks.map((c) => (
              <p key={c.id}>
                <span className="text-neutral-600">
                  [{c.sourceType} · {c.score.toFixed(2)}]{' '}
                </span>
                {c.content.slice(0, 140)}
                {c.content.length > 140 ? '…' : ''}
              </p>
            ))
          )}
        </div>
      )}
    </div>
  );
}
