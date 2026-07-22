import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';

export interface TourStep {
  /** value of a `data-tour="…"` attribute to spotlight; omit for a centered step */
  target?: string;
  title: string;
  body: string;
}

/** First-run walkthrough. Steps spotlight sidebar entries or Home's mode cards
 *  by `data-tour`; when a target isn't on-screen (e.g. replaying the tour from
 *  Settings), that step gracefully falls back to a centered card. */
export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to BrainCue 👋',
    body: 'BrainCue hears the conversation you’re actually in — an interview, a meeting, or just your working day — and contributes through a floating, screen-share-invisible Cue Card, or its own voice. It runs on your machine, on your own API key. Here’s the whole flow in about a minute.',
  },
  {
    target: 'nav-settings',
    title: '1 · Add your OpenAI key',
    body: 'Everything runs on your own key. Paste it in Settings — it’s encrypted in your OS keychain and never leaves the main process except to call OpenAI. Defaults use cost-effective models; you can override any model per task here.',
  },
  {
    target: 'nav-library',
    title: '2 · Build your Library',
    body: 'The Library holds what BrainCue should know: your profile (name, role, résumé), your Spaces — one per context, like a job with its JD and company research — and Memory. Everything is parsed and indexed locally, so contributions are grounded in YOUR real world instead of invented.',
  },
  {
    target: 'nav-home',
    title: '3 · Start from Home',
    body: 'Home is the launcher. “Start listening” opens one shared start flow for every mode: pick the mode, the Space that grounds it, and what to listen to — then see exactly what gets captured and what leaves your machine, before anything starts.',
  },
  {
    target: 'primary-actions',
    title: '4 · Four ways in',
    body: 'Start listening for a live session · Talk to BrainCue to ask by voice · Share screen to capture a region and solve it · Add context to create a Space. Nothing captures anything until you explicitly start it.',
  },
  {
    target: 'mode-interview',
    title: 'Interview Copilot',
    body: 'You’re the candidate. BrainCue hears the interviewer’s questions and streams grounded answer cues into the Cue Card — with the format (key points, explanation, STAR story) switchable live, mid-answer.',
  },
  {
    target: 'mode-practice',
    title: 'Practice',
    body: 'Rehearse out loud before the real thing: a mock interviewer asks questions with a voice, or a sparring drill coaches every spoken answer. The safest way to see BrainCue work.',
  },
  {
    target: 'mode-meeting',
    title: 'Meeting Copilot · Labs',
    body: 'Sits in quietly and surfaces context, open questions, action items, and decisions — only when it’s confident. A Presence dial (summoned → quiet → balanced → active) sets explicit thresholds, so “how much it talks” is a number you choose, not a vibe.',
  },
  {
    target: 'mode-companion',
    title: 'Companion · Labs',
    body: 'An ambient presence while you work: it remembers what you saved, flags tasks, and offers context — through deterministic gates you control. Set a posture (Off is a hard mute), quiet hours, and a hard per-session spend cap. Silence and small talk never cost a model call.',
  },
  {
    title: 'Talk to BrainCue',
    body: 'Press Ctrl+Shift+T anywhere to summon it: push-to-talk, and the answer comes back spoken and on-screen. Start talking over it and it stops to listen. Works with a session live — or on its own, when you just have a question.',
  },
  {
    title: 'The Cue Card is your live surface',
    body: 'Everything lands here: the live transcript, streamed cards and answers, and the controls to retune them. It’s always-on-top and excluded from screen sharing and recording — there for you, invisible to everyone else. Toggle it from the tray or a hotkey.',
  },
  {
    title: 'Memory — off until you say so',
    body: 'BrainCue can remember things across sessions, but nothing is remembered silently: memories are proposed, and only ones you approve in the Library are ever recalled. You can correct or forget any of them, right from the card that used it.',
  },
  {
    target: 'nav-sessions',
    title: 'Review afterwards',
    body: 'Sessions is your history. Interviews get a coaching report — summary, strengths, improvements, per-question notes; meetings get their own structured report with decisions and action items. Insights aggregates your progress over time.',
  },
  {
    target: 'nav-settings',
    title: 'Stay invisible — and in control',
    body: 'Privacy Mode (Ctrl+Shift+H) hides every window from screen capture; you can also hide the app from the taskbar. Settings → Danger zone resets settings or wipes all local data. More modes — Interviewer Assist and Tutor — are on the way; Home’s Labs strip shows what’s coming.',
  },
  {
    title: 'You’re set 🚀',
    body: 'That’s the flow: Library → Home → Start listening → the Cue Card → Sessions. Replay this tour anytime from Settings → Getting started.',
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
