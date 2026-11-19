import { useState } from 'react';
import { api } from '../../lib/api';
import { noDrag } from '../lib/style';

/** The escape hatch when detection misses: "Answer that" answers what the
 *  interviewer just said, in one tap; the box asks anything typed. Available
 *  whenever a session is live. */
export function AskBar() {
  const [askText, setAskText] = useState('');
  const sendAsk = () => {
    const t = askText.trim();
    if (!t) return;
    void api.session.askActive(t).catch(() => {}); // errors surface via sessionError
    setAskText('');
  };
  return (
    <div data-ct-interactive data-cue-askbar className="mt-2 flex h-10 shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-neutral-950/60 p-1 shadow-sm focus-within:border-indigo-400/40" style={noDrag}>
      <button
        onClick={() => void api.session.answerLast().catch(() => {})}
        title="Answer what the interviewer just said — when it wasn't picked up as a question"
        className="h-7 shrink-0 rounded-lg bg-indigo-400/10 px-2 text-[11px] font-medium text-indigo-200 outline-none hover:bg-indigo-400/20 focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        Answer that
      </button>
      <input
        value={askText}
        onChange={(e) => setAskText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && sendAsk()}
        placeholder="Or type a question…"
        aria-label="Ask a question"
        className="h-7 min-w-0 flex-1 bg-transparent px-2 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600"
      />
      <button
        onClick={sendAsk}
        className="h-7 rounded-lg bg-indigo-500 px-3 text-[11px] font-medium text-white outline-none hover:bg-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-300"
      >
        Ask
      </button>
    </div>
  );
}
