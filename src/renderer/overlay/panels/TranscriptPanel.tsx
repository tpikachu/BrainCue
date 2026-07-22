import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { noDrag } from '../lib/style';

/** A transcript line in the Cue Card (mirrors the dashboard store's Line). */
export interface Line {
  id: number;
  speaker: string;
  text: string;
}

// Cap transcript lines kept in the DOM — a long interview can produce thousands.
export const MAX_LINES = 300;

/** Live transcript — resizable height (drag the handle below it) with
 *  pin-to-newest scrolling. Lets the dashboard be minimized during the session. */
export function TranscriptPanel({ lines, interim }: { lines: Line[]; interim: string }) {
  const [height, setHeight] = useState(150);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the transcript pinned to the newest line unless the user scrolled up.
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, interim, atBottom]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
  };

  // Drag the bottom edge of the transcript pane to resize its height.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const next = startH + (ev.clientY - startY);
      // Cap at half the window so the answer pane always keeps a usable area.
      const max = Math.max(80, Math.floor(window.innerHeight * 0.5));
      setHeight(Math.max(60, Math.min(max, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div
        data-ct-interactive
        className="relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950/50"
        style={{ ...noDrag, height }}
      >
        <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500">
          <span>Transcript</span>
          {lines.length > MAX_LINES && <span>last {MAX_LINES}</span>}
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 space-y-1 overflow-y-auto px-2 pb-2 text-[11px] leading-snug"
        >
          {lines.length === 0 && !interim ? (
            <p className="text-neutral-600">Listening… the conversation will appear here.</p>
          ) : (
            <>
              {lines.slice(-MAX_LINES).map((l) => (
                <p key={l.id}>
                  <span
                    className={
                      l.speaker === 'detected question' ? 'text-blue-400' : 'text-neutral-500'
                    }
                  >
                    {l.speaker}:{' '}
                  </span>
                  <span className="text-neutral-300">{l.text}</span>
                </p>
              ))}
              {interim && (
                <p className="italic text-neutral-500">
                  interviewer: {interim}
                  <span className="ml-0.5 animate-pulse">▋</span>
                </p>
              )}
            </>
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setAtBottom(true);
            }}
            className="absolute bottom-1 right-2 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white shadow hover:bg-blue-500"
          >
            ↓ latest
          </button>
        )}
      </div>
      {/* Resize handle — drag to change the transcript height. */}
      <div
        data-ct-interactive
        onMouseDown={startResize}
        title="Drag to resize the transcript"
        className="mb-2 mt-0.5 h-1.5 shrink-0 cursor-row-resize rounded bg-neutral-800 transition-colors hover:bg-neutral-600"
        style={noDrag}
      />
    </>
  );
}
