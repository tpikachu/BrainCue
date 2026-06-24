import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';

export interface TourStep {
  /** value of a `data-tour="…"` attribute to spotlight; omit for a centered step */
  target?: string;
  title: string;
  body: string;
}

/** First-run walkthrough. Steps spotlight sidebar entries (always on-screen), so
 *  the tour works regardless of the current route. */
export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to BrainCue 👋',
    body: 'Your AI copilot for live interviews — it listens, detects questions, and streams grounded answer cues into a floating, screen-share-invisible panel. Here’s the full workflow in about a minute.',
  },
  {
    target: 'nav-settings',
    title: '1 · Add your OpenAI key',
    body: 'Everything runs on your own key. Paste it in Settings — it’s encrypted in your OS keychain and never leaves your machine except to call OpenAI. Tip: defaults use cost-effective models; you can change any model per task here.',
  },
  {
    target: 'nav-profiles',
    title: '2 · Create your profile',
    body: 'A profile is you: name, target role, and résumé. We parse the résumé so answers are grounded in YOUR real experience — never made up. Create it once and reuse it for every interview.',
  },
  {
    target: 'nav-session',
    title: '3 · Add an interview',
    body: 'On the Interview page, add the job: paste the JD (or a link), and optionally a company website — we research it so answers can speak to the company’s products and values. Each interview is saved and reusable.',
  },
  {
    target: 'nav-session',
    title: '4 · Start it',
    body: 'Pick the profile, then press Start on an interview row. Your mic/system audio is captured and the floating Cue Card opens — you can minimize this dashboard during the call.',
  },
  {
    title: '5 · The Cue Card is your live surface',
    body: 'Everything happens here: the live transcript (resizable), the streamed answer, and which profile · interview is loaded. It’s always-on-top and excluded from screen sharing. Toggle it with the tray or hotkey.',
  },
  {
    title: '6 · Tune answers on the fly',
    body: 'In the Cue Card you can change Interview Type, Answer Format, and Length live; toggle pronunciation hints; Regenerate or Clear an answer; type a manual question in the Ask box; and pick your mic in ⚙ Settings.',
  },
  {
    title: '7 · Stop & save',
    body: 'When you stop, we ask whether to Save the session to Reports (you pick what kind of interview it was) or Discard it. Nothing is kept unless you choose to save.',
  },
  {
    target: 'nav-mock',
    title: 'Practice with a mock interviewer',
    body: 'Mock Interview runs an AI interviewer that asks questions aloud — a safe way to rehearse and to see the copilot in action. (Mock runs aren’t saved to Reports.)',
  },
  {
    target: 'nav-reports',
    title: 'Review afterwards',
    body: 'Reports group by client → interview → session, with a per-question type breakdown. Open any session for a coaching report: summary, strengths, improvements, and per-question notes.',
  },
  {
    target: 'nav-settings',
    title: 'Stay invisible — and in control',
    body: 'Privacy Mode (Ctrl+Shift+H) hides every window from screen capture; you can also hide the app from the taskbar. Need a clean slate? Settings → Danger zone lets you reset settings or wipe all data.',
  },
  {
    title: 'You’re set 🚀',
    body: 'That’s the whole flow: profile → interview → Start → Cue Card → Stop & save → Reports. Replay this tour anytime from Settings → Getting started.',
  },
];

export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  const step = steps[i];
  const last = i === steps.length - 1;

  // Locate the target element and reposition the card; recompute on resize.
  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target
        ? (document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null)
        : null;
      const r = el?.getBoundingClientRect() ?? null;
      setRect(r);

      const card = cardRef.current;
      const cw = card?.offsetWidth ?? 320;
      const ch = card?.offsetHeight ?? 190;
      const m = 14;
      if (!r) {
        setPos({ top: (window.innerHeight - ch) / 2, left: (window.innerWidth - cw) / 2 });
        return;
      }
      // Prefer right of the target (sidebar is on the left); flip left if needed.
      let left = r.right + m;
      if (left + cw > window.innerWidth - m) left = r.left - cw - m;
      left = Math.max(m, Math.min(left, window.innerWidth - cw - m));
      let top = r.top;
      top = Math.max(m, Math.min(top, window.innerHeight - ch - m));
      setPos({ top, left });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [i, step.target]);

  const pad = 6;
  return (
    <div className="fixed inset-0 z-[60]">
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-indigo-400 transition-all duration-200"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.66)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/66" />
      )}

      <div
        ref={cardRef}
        className="absolute w-80 rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
        style={{ top: pos.top, left: pos.left }}
      >
        <div className="mb-1 text-xs text-neutral-500">
          Step {i + 1} of {steps.length}
        </div>
        <h3 className="mb-1.5 font-semibold text-neutral-100">{step.title}</h3>
        <p className="mb-4 text-sm leading-relaxed text-neutral-300">{step.body}</p>
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
            {last ? '' : 'Skip tour'}
          </button>
          <div className="flex gap-2">
            {i > 0 && (
              <Button variant="ghost" onClick={() => setI(i - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary" onClick={() => (last ? onClose() : setI(i + 1))}>
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
