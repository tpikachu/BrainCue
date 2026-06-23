import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { CloseIcon } from '../components/icons';

interface Point {
  x: number;
  y: number;
}
type Phase = 'select' | 'processing' | 'error';

export default function RegionSelector() {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [cur, setCur] = useState<Point | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [message, setMessage] = useState('Drag to select the problem area');

  useEffect(() => {
    void (async () => {
      const { image } = (await api.capture.getFrame()) as { image: string | null };
      if (!image) {
        setPhase('error');
        setMessage('Could not capture the screen. Press Esc and try again.');
        return;
      }
      setFrame(image);
      const img = new Image();
      img.onload = () => (imgRef.current = img);
      img.src = image;
    })();
  }, []);

  const cancel = useCallback(() => void api.capture.closeSelector(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const rect =
    start && cur
      ? {
          left: Math.min(start.x, cur.x),
          top: Math.min(start.y, cur.y),
          width: Math.abs(cur.x - start.x),
          height: Math.abs(cur.y - start.y),
        }
      : null;

  const finish = async () => {
    const img = imgRef.current;
    if (!img || !rect || rect.width < 8 || rect.height < 8) {
      setStart(null);
      setCur(null);
      return;
    }
    setPhase('processing');
    setMessage('Generating solution…');

    const scale = img.naturalWidth / window.innerWidth;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(
      img,
      rect.left * scale,
      rect.top * scale,
      rect.width * scale,
      rect.height * scale,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const crop = canvas.toDataURL('image/png');

    try {
      setMessage('Generating solution…');
      await api.capture.solveImage(crop); // OpenAI vision → streams to the overlay
      await api.capture.closeSelector();
    } catch (e) {
      setPhase('error');
      setMessage(`Error: ${(e as Error).message}`);
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (phase !== 'select') return;
    setStart({ x: e.clientX, y: e.clientY });
    setCur({ x: e.clientX, y: e.clientY });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (phase !== 'select' || !start) return;
    setCur({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => void finish()}
    >
      {/* The window is opaque: paint the frozen screenshot as the full-screen
          background so the selector is always visible. The user drag-selects
          over this frozen frame (WYSIWYG), and the same image is cropped for the
          solve. Sized 1:1 to the window so selection coordinates map directly. */}
      {frame && (
        <img
          src={frame}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
        />
      )}

      {/* Dim everything, then "cut out" the selection with a giant box-shadow */}
      {rect ? (
        <div
          className="absolute border-2 border-blue-400"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        >
          <span className="absolute -top-6 left-0 rounded bg-blue-500 px-1.5 py-0.5 text-[11px] text-white">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      ) : (
        <div className="absolute inset-0 bg-black/40" />
      )}

      {/* Instruction / status banner */}
      <div className="pointer-events-none fixed left-1/2 top-6 -translate-x-1/2">
        <div
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm shadow-lg ${
            phase === 'error' ? 'bg-red-600 text-white' : 'bg-neutral-900/90 text-neutral-100'
          }`}
        >
          {phase === 'processing' && (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {message}
          {phase === 'select' && <span className="text-neutral-400">· Esc to cancel</span>}
        </div>
      </div>

      {/* Cancel button (always clickable) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          cancel();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="fixed right-6 top-6 inline-flex items-center gap-1.5 rounded-full bg-neutral-900/90 px-3 py-2 text-sm text-neutral-100 shadow-lg hover:bg-neutral-800"
      >
        <CloseIcon /> Cancel
      </button>
    </div>
  );
}
