import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';

/** How long to wait for a step's anchor to mount after its route is taken.
 *  ~1.2s total: long enough for a page that fetches before it renders, short
 *  enough that a genuinely missing anchor does not stall the tour. */
const POLL_MS = 60;
const POLL_TRIES = 20;

export interface TourStep {
  /** value of a `data-tour="…"` attribute to spotlight; omit for a centered step */
  target?: string;
  /**
   * Route to open before spotlighting, so the step can point at the actual
   * card rather than at the nav item that leads to it.
   *
   * Highlighting "Library" in the sidebar tells you where to click and nothing
   * about what you would find — the tour is worth more when it takes you there
   * and rings the Spaces list itself. Steps that describe the shell (the
   * switcher, the title bar) leave this out and stay wherever you are.
   */
  route?: string;
  /** The chapter this step belongs to, shown above the title so a fifteen-step
   *  tour reads as four short chapters rather than as a countdown. */
  chapter: string;
  title: string;
  body: string;
}

/**
 * The first-run walkthrough.
 *
 * Steps spotlight a `data-tour` anchor; when the target is not on screen — the
 * tour is replayable from Settings and from Help, where Home's cards are not
 * mounted — that step falls back to a centered card rather than breaking.
 *
 * Written to be read once, by someone who has just installed this and does not
 * yet know what it is. Two rules keep it honest:
 *
 *  - **Say what the thing IS before saying where it lives.** "Memory is under
 *    this nav item" helps nobody who does not know why an app would remember
 *    anything. Each step leads with the idea and lands on the surface.
 *  - **Include the consequences, not only the capabilities.** A conversation
 *    kept with no Space keeps nothing; memory is off until switched on; Privacy
 *    Mode blanks your own screenshots too. Discovering those later feels like a
 *    bug — hearing them here makes them a design.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    chapter: 'Welcome',
    title: 'The AI that’s in the room with you',
    body: 'BrainCue listens to the conversation you are actually in — a standup, a client call, an interview, or just your working day — and contributes through a floating Cue Card that is invisible to screen sharing, or through its own voice. Everything runs on this machine, on your own API key. This takes about ninety seconds and covers the whole loop.',
  },
  {
    chapter: 'Welcome',
    target: 'titlebar-help',
    title: 'You can always get back here',
    body: 'The “?” in the title bar opens Help: a quick start, what every activity does, the keyboard shortcuts, and answers to the questions people actually arrive with — including why something was not remembered. You can replay this tour from there at any time, so nothing you skip now is lost.',
  },

  {
    chapter: 'Setup',
    route: '/settings',
    target: 'settings-key',
    title: '1 · Your key, your models',
    body: 'BrainCue has no account and no server of its own. Paste an OpenAI key in Settings and every call is billed to you directly — which is also why it is careful about making them. The key is encrypted by your operating system’s keychain and stays in the background process; the part of the app you can see never receives it, only whether one is present.',
  },
  {
    chapter: 'Setup',
    target: 'profile-switcher',
    title: '2 · Who this is for',
    body: 'BrainCue works for one person at a time. This switcher scopes everything beneath it — Home, Library, Memory, Sessions, and Insights all show that person and nobody else. Profiles and Settings sit below the divider because they are not about any one person; the group above it is.',
  },
  {
    chapter: 'Setup',
    route: '/library',
    target: 'library-content',
    title: '3 · What it should already know',
    body: 'The Library holds the Spaces and documents that ground every answer. A Space is one recurring context — a standup with its agenda, a role with its job description, a house move with the dates — and setting one up takes a minute. Everything you add is parsed and indexed here on your disk, so contributions come from your real world instead of being invented.',
  },

  {
    chapter: 'Using it',
    route: '/home',
    target: 'primary-actions',
    title: '4 · Starting a conversation',
    body: 'Home is the launcher. “Start listening” opens one flow for every kind of conversation: say what the call IS — a meeting, an interview, a study session — and everything else follows from that answer. You never pick a mode. Before anything starts you are shown exactly what will be captured on this machine and what will leave it, for the session you are about to run.',
  },
  {
    chapter: 'Using it',
    route: '/home',
    target: 'activity-meeting',
    title: '5 · It is built to stay quiet',
    body: 'An assistant in a real conversation is judged by when it does NOT speak. Presence is an explicit threshold you set at the start — Summoned only, Quiet, Balanced, or Active — not a mood. On Quiet, the default, most turns never reach a model at all: silence, small talk, and anything below the confidence bar are filtered out before a call is made, which is why an hour of listening costs so little.',
  },
  {
    chapter: 'Using it',
    title: '6 · The Cue Card is the live surface',
    body: 'Everything lands in the floating Cue Card: the running transcript, streamed cards and answers, and the controls to retune them mid-answer. It is always on top for you and excluded from screen sharing and recording for everyone else. One caveat worth knowing now — while that exclusion is on, your own screenshots of BrainCue come out blank too.',
  },
  {
    chapter: 'Using it',
    title: '7 · Ask it directly, any time',
    body: 'You do not have to wait for it to volunteer. Press the summon shortcut anywhere — even with no session running — and talk; the answer comes back spoken and on screen, and it stops the moment you speak over it. You can also drag-select a region of your screen, or solve whatever you have just copied, straight into the Cue Card.',
  },

  {
    chapter: 'What it keeps',
    title: '8 · Nothing is kept until you say so',
    body: 'When you stop a session, BrainCue asks one question: keep this conversation, and in which Space? Answering is what triggers everything downstream. Choose no Space and nothing is summarised and nothing is proposed — the session and its transcript are still saved, but it leaves no trace in what BrainCue knows. That is a legitimate choice, and it is offered before you start as well as after you finish.',
  },
  {
    chapter: 'What it keeps',
    route: '/memory',
    target: 'memory-switches',
    title: '9 · Two different things, two different defaults',
    body: 'A SUMMARY answers “what happened in that call?” — filed into the Space it happened in, so the tenth standup is grounded in the previous nine, and deleted along with its session. That is on by default. LONG-TERM MEMORY answers “what is true about me?” — a standing claim like “keeps updates under a minute”, which outlives every conversation. Because a wrong one would be repeated forever, it is off until you turn it on.',
  },
  {
    chapter: 'What it keeps',
    route: '/memory',
    target: 'memory-queue',
    title: '10 · You approve every memory, one at a time',
    body: 'Suggestions arrive here after a session and sit unused until you press Approve — nothing pending is ever recalled. Edit the wording first if it is nearly right; reject it and the same sentence is not raised again. Each memory belongs either to one Space or to you generally, so you can see exactly what each context knows, and correct or delete any of it later from the very card that used it.',
  },

  {
    chapter: 'Afterwards',
    route: '/sessions',
    target: 'sessions-table',
    title: '11 · Reviewing what happened',
    body: 'Sessions keeps the full history for this profile, with transcripts and reports: interviews get a coaching report with strengths, improvements, and per-question notes; meetings get a structured report with decisions and action items. Insights aggregates the practice sessions over time, so you can see whether you are actually improving.',
  },
  {
    chapter: 'Afterwards',
    route: '/settings',
    target: 'settings-privacy',
    title: '12 · Staying invisible, and in control',
    body: 'Privacy Mode hides every BrainCue window from screen capture and recording, and can be toggled with a shortcut mid-call. Every shortcut is rebindable. Your data — transcripts, documents, embeddings, summaries, memory — lives in a local database on this machine, which is why Settings → Danger zone can genuinely erase all of it, and why there is no backup but yours.',
  },
  {
    chapter: 'Afterwards',
    title: 'That’s the loop',
    body: 'Library → Home → Start listening → the Cue Card → keep it into a Space → review what it proposed. Everything else is detail, and the “?” in the title bar has it when you want it. Two things are still on the way: assisting you when YOU are the one interviewing, and guided tutoring.',
  },
];

export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  const step = steps[i];
  const last = i === steps.length - 1;
  // Where this step sits within its chapter, for the progress line. Cheap to
  // recompute and it keeps the chapters defined in ONE place — the steps.
  const chapters = steps.map((s) => s.chapter).filter((c, n, all) => all.indexOf(c) === n);

  // Take the step's route before looking for its anchor. Navigating from inside
  // the effect that measures would race the router; doing it first means the
  // measure pass below simply polls until the new page has mounted.
  useEffect(() => {
    if (step.route && location.pathname !== step.route) navigate(step.route);
  }, [step.route, location.pathname, navigate]);

  // Locate the target element and reposition the card; recompute on resize.
  //
  // The anchor may not exist yet (the route above is still mounting) or may be
  // below the fold, so this polls briefly and scrolls the target into view
  // before measuring. A target that never appears falls back to a centered
  // card, which is also what a step with no target gets.
  useLayoutEffect(() => {
    let timer = 0;
    let tries = 0;
    // Scroll the target into view ONCE per step. Doing it on every measure
    // would loop forever: the scroll listener below re-measures, which would
    // scroll again, which would re-measure.
    let centered = false;
    const measure = () => {
      const el = step.target
        ? (document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null)
        : null;
      if (step.target && !el && tries < POLL_TRIES) {
        tries += 1;
        timer = window.setTimeout(measure, POLL_MS);
        return;
      }
      if (el && !centered) {
        centered = true;
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
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
    // A re-measure on scroll as well as resize: the target is scrolled into
    // view above, and any later scroll would leave the ring behind.
    const remeasure = () => measure();
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true); // capture: inner scrollers too
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [i, step.target, location.pathname]);

  const pad = 6;
  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Guided tour">
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
        className="absolute w-[22rem] rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
        style={{ top: pos.top, left: pos.left }}
      >
        {/* Chapter ticks rather than "step 7 of 14": a bare count out of fourteen
            reads as a chore, while four named chapters read as a short story
            with a visible end. */}
        <div className="mb-2.5 flex items-center gap-2">
          {chapters.map((c) => (
            <span
              key={c}
              className={`h-1 flex-1 rounded-full transition-colors ${
                c === step.chapter
                  ? 'bg-indigo-400'
                  : chapters.indexOf(c) < chapters.indexOf(step.chapter)
                    ? 'bg-indigo-400/35'
                    : 'bg-white/10'
              }`}
            />
          ))}
        </div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          {step.chapter}
          <span className="ml-2 normal-case tracking-normal text-neutral-600">
            {i + 1}/{steps.length}
          </span>
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
