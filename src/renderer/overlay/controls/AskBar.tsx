import { useState } from 'react';
import { api } from '../../lib/api';
import { noDrag } from '../lib/style';

/** Manual "Ask" box — type a question (handy when auto-detection misses one, or
 *  to test grounded answering). Available whenever a session is live. */
export function AskBar() {
  const [askText, setAskText] = useState('');
  const sendAsk = () => {
    const t = askText.trim();
    if (!t) return;
    void api.session.askActive(t).catch(() => {}); // errors surface via sessionError
    setAskText('');
  };
  return (
    <div data-ct-interactive className="mt-2 flex shrink-0 gap-1" style={noDrag}>
      <input
        value={askText}
        onChange={(e) => setAskText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && sendAsk()}
        placeholder="Ask a question…"
        className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-indigo-500"
      />
      <button
        onClick={sendAsk}
        className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
      >
        Ask
      </button>
    </div>
  );
}
