import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTIVITIES, ACTIVITY_ORDER, startableActivities } from '@shared/activities';
import { SHORTCUT_DEFS } from '@shared/shortcuts';
import { useTourStore } from '../../store/useTourStore';
import { Badge, Button, Card, Page } from '../../components/ui';

/**
 * Help & FAQ — the manual, in the app.
 *
 * Reachable from the “?” in the title bar, from anywhere, at any time. It
 * exists because the guided tour is a one-time thing shown before the user has
 * done anything: it is the right shape for "where do I click" and the wrong
 * shape for "why did nothing get remembered", which is the question people
 * actually arrive with.
 *
 * Two rules for the content below, both load-bearing:
 *
 *  1. **It is generated from the source of truth wherever one exists.** The
 *     activity list comes from `ACTIVITIES`, the shortcuts from
 *     `SHORTCUT_DEFS`. A hand-typed list of either would be wrong within a
 *     release, and wrong help is worse than no help.
 *  2. **The answers say what actually happens, including the limits.** An FAQ
 *     that only lists what works is marketing. The entries about macOS system
 *     audio, unsigned builds, and what a Space costs you if you skip it are the
 *     ones worth having.
 */

/** The repository, for the two outward links at the bottom of the page. */
const REPO = 'https://github.com/tpikachu/BrainCue';

const nbsp = (accel: string) =>
  accel.replace('CommandOrControl', navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl');

interface Faq {
  q: string;
  a: React.ReactNode;
}

const FAQS: { group: string; items: Faq[] }[] = [
  {
    group: 'Getting started',
    items: [
      {
        q: 'What do I need before BrainCue can do anything?',
        a: (
          <>
            An <b>OpenAI API key</b> of your own, pasted into Settings, and a{' '}
            <b>profile</b> — one person BrainCue works for. Nothing listens, transcribes, or
            answers without a key: it pays for every call itself, from your account. The key is
            encrypted by your OS keychain and stays in the main process; the part of the app you
            can see never receives it.
          </>
        ),
      },
      {
        q: 'Does it cost anything to run?',
        a: (
          <>
            BrainCue is free and open source. You pay OpenAI directly for what you use — mostly
            real-time transcription while a session runs, plus a call each time it actually
            contributes. Silence, small talk, and anything below its confidence threshold cost
            nothing, and ambient sessions can be given a hard per-session spend cap.
          </>
        ),
      },
      {
        q: 'What is a profile, and why only one at a time?',
        a: (
          <>
            A profile is one person: their documents, Spaces, sessions, and memory. The dashboard
            is scoped to whichever profile is selected in the sidebar, because &ldquo;whose
            conversation is this?&rdquo; has exactly one answer at any moment. Switch profiles in
            the sidebar; manage them under <b>Profiles</b>, which is global and sits below the
            divider for that reason.
          </>
        ),
      },
    ],
  },
  {
    group: 'During a conversation',
    items: [
      {
        q: 'How does it hear the other side of a call?',
        a: (
          <>
            <b>System audio</b> — it captures what your speakers are playing, which is the other
            participants. For an in-person conversation choose <b>Microphone</b> instead. On
            Windows this works out of the box; on <b>macOS</b> capturing system audio needs a
            virtual audio device such as BlackHole, and without one only the microphone path
            works.
          </>
        ),
      },
      {
        q: 'Will people see BrainCue if I share my screen?',
        a: (
          <>
            No. Privacy Mode excludes every BrainCue window from screen capture and recording at
            the OS level, so the Cue Card is on your screen and absent from the share. Two honest
            caveats: it is most reliable on Windows 10 version 2004+ and Windows 11 (older builds
            may render the window black to viewers rather than excluding it cleanly), and while
            it is on, screenshots of BrainCue itself come out blank — including any you try to
            take yourself.
          </>
        ),
      },
      {
        q: 'Why is it staying quiet?',
        a: (
          <>
            Because that is the default, and it is deliberate. An ambient assistant is judged by
            when it does <i>not</i> speak. <b>Presence</b> sets an explicit threshold — Summoned
            only, Quiet, Balanced, or Active — and you pick it when the session starts. If you
            want an answer right now, ask: press the summon shortcut and talk, or type into the
            Cue Card.
          </>
        ),
      },
      {
        q: 'It said something wrong. Where did that come from?',
        a: (
          <>
            Every contribution is grounded in retrieved chunks of <i>your</i> material —
            documents, a Space&rsquo;s background, earlier conversations in that Space, and any
            memory you approved. Cards show what they drew on, so a wrong answer is traceable to
            a wrong source: fix the document, or correct the memory from the card that used it.
            When nothing matches, it is built to say so rather than invent.
          </>
        ),
      },
    ],
  },
  {
    group: 'Spaces & memory',
    items: [
      {
        q: 'I kept a conversation but nothing was remembered. Why?',
        a: (
          <>
            Almost certainly no <b>Space</b>. A Space is the only place a conversation is kept —
            without one there is nowhere to file a summary, so nothing is summarised and nothing
            is suggested for memory. The session and its transcript are still saved. Pick or
            create a Space when the session starts, or choose one at the save prompt when it
            ends; both work equally well.
          </>
        ),
      },
      {
        q: 'What is the difference between a summary and a memory?',
        a: (
          <>
            A <b>summary</b> answers &ldquo;what happened in that call?&rdquo; — it is filed into
            the Space it happened in, needs no approval, and is deleted with its session. A{' '}
            <b>memory</b> answers &ldquo;what is true about me?&rdquo; — a standing claim that
            outlives the conversation, so it is off until you allow it and every item is
            approved one at a time. They are independent: turning summaries off still lets
            memory be suggested, and turning memory off still summarises.
          </>
        ),
      },
      {
        q: 'Why did it propose something I do not want remembered?',
        a: (
          <>
            Because proposing is all it can do. Nothing is recalled until you press Approve, so
            Reject costs you nothing and the same sentence is not raised again. You can also edit
            a suggestion before approving it — what you save is what gets remembered, not what
            the model wrote.
          </>
        ),
      },
      {
        q: 'Can a Space see another Space&rsquo;s history?',
        a: (
          <>
            No, and that is the point. A summary never leaves the Space it happened in, so one
            client&rsquo;s call cannot ground another client&rsquo;s. A <i>memory</i> can be
            scoped either way: to one Space, or profile-wide so it follows you everywhere. The
            Memory page shows which is which, and lets you move one.
          </>
        ),
      },
      {
        q: 'How do I make it forget something?',
        a: (
          <>
            Delete the memory on the Memory page — the row and its embedding go together, so
            nothing is left behind to be recalled. Deleting a Space takes its memory with it;
            deleting a session takes its summary and any suggestions it had made. Settings →
            Danger zone wipes everything local in one action.
          </>
        ),
      },
    ],
  },
  {
    group: 'Privacy & data',
    items: [
      {
        q: 'What actually leaves my machine?',
        a: (
          <>
            Audio goes to OpenAI for transcription while a session runs. When a contribution is
            made, the current moment of conversation plus the top few matching chunks are sent —
            never a whole document, never your full résumé, never your screen unless you
            explicitly capture a region. The start flow lists this in full before anything
            starts, for the specific session you are about to run.
          </>
        ),
      },
      {
        q: 'Where is my data stored?',
        a: (
          <>
            In a SQLite database in your user-data directory, on this machine. Transcripts,
            documents, embeddings, summaries, and memory all live there. There is no account, no
            sync, and no BrainCue server — which also means there is no backup but yours.
          </>
        ),
      },
      {
        q: 'Is it ethical to use this?',
        a: (
          <>
            Use it only where AI assistance is permitted. BrainCue does no anti-proctoring and no
            detection evasion; Privacy Mode is a screen-sharing exclusion so your own notes are
            not broadcast, not a tool for hiding from someone who has asked you not to use
            assistance. In an interview, that is a question to ask the company.
          </>
        ),
      },
    ],
  },
  {
    group: 'Troubleshooting',
    items: [
      {
        q: 'Windows or macOS warned me when I installed it.',
        a: (
          <>
            Builds are currently <b>unsigned</b>, so Windows SmartScreen shows &ldquo;More info →
            Run anyway&rdquo; and macOS Gatekeeper needs right-click → Open. Code-signing
            certificates are on the list; until then the warning is expected rather than a sign
            something is wrong.
          </>
        ),
      },
      {
        q: 'Nothing is being transcribed.',
        a: (
          <>
            Check three things in order: the API key is set in Settings, the microphone
            permission is granted (Home shows its state), and the audio source matches the
            conversation — <b>System audio</b> for an online call, <b>Microphone</b> for the room
            you are in. On macOS, system audio additionally needs a virtual audio device.
          </>
        ),
      },
      {
        q: 'A window is blank or black.',
        a: (
          <>
            Usually a hybrid-GPU laptop. Launch with <code>--disable-gpu</code> (or set{' '}
            <code>AI_DISABLE_GPU=1</code>) to fall back to software rendering. If only BrainCue
            windows look black <i>to other people</i> on a call, that is Privacy Mode working on
            an older Windows build.
          </>
        ),
      },
      {
        q: 'A shortcut does nothing.',
        a: (
          <>
            Another application has almost certainly claimed it first — global shortcuts are
            first-come, first-served at the OS level. Rebind it in Settings → Shortcuts; every
            one of them is editable.
          </>
        ),
      },
    ],
  },
];

function FaqItem({ item }: { item: Faq }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-3 text-left text-sm font-medium text-neutral-200 transition-colors hover:text-white"
      >
        <span>{item.q}</span>
        <span aria-hidden className={`shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-45' : ''}`}>
          +
        </span>
      </button>
      {open && <p className="pb-4 pr-8 text-sm leading-relaxed text-neutral-400">{item.a}</p>}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-indigo-400/40 bg-indigo-500/10 text-xs font-semibold text-indigo-300">
        {n}
      </span>
      <span className="text-sm leading-relaxed text-neutral-400">
        <b className="text-neutral-200">{title}</b> — {children}
      </span>
    </li>
  );
}

export default function HelpPage() {
  const startTour = useTourStore((s) => s.start);
  const startable = new Set(startableActivities());

  return (
    <Page
      title="Help"
      subtitle="How BrainCue works, what it keeps, and the answers to the questions people actually ask."
      width="max-w-3xl"
      actions={
        <Button variant="primary" onClick={startTour}>
          Replay the tour
        </Button>
      }
    >
      <div className="space-y-6">
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-neutral-100">Quick start</h3>
          <ol className="space-y-3">
            <Step n={1} title="Add your OpenAI key">
              Settings → OpenAI. It is encrypted by your OS keychain and never reaches the part of
              the app you can see. Nothing works without it.
            </Step>
            <Step n={2} title="Create a profile">
              One person BrainCue works for. The sidebar switcher scopes every page under it.
            </Step>
            <Step n={3} title="Give it something to work from">
              Library → add a Space for a context you talk about repeatedly, and paste in what
              defines it: an agenda, a job description, a project brief. Everything is parsed and
              indexed on this machine.
            </Step>
            <Step n={4} title="Start listening">
              Say what the call is, pick the Space it belongs to, and choose what to listen to.
              You see exactly what will be captured and sent before anything starts.
            </Step>
            <Step n={5} title="Keep it, or do not">
              When you stop, decide whether to keep the conversation and where. Keeping it files a
              summary into that Space and proposes anything worth remembering, for you to review.
            </Step>
          </ol>
        </Card>

        <Card>
          <h3 className="mb-1 text-sm font-semibold text-neutral-100">What it can sit in on</h3>
          <p className="mb-4 text-sm text-neutral-400">
            You pick an activity, never a mode. What it listens to, when it speaks up, how it
            frames you, and the shape of its summary all follow from this one answer.
          </p>
          <dl className="space-y-2.5">
            {ACTIVITY_ORDER.map((kind) => (
              <div key={kind} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                <dt className="flex shrink-0 items-center gap-2 text-sm font-medium text-neutral-200 sm:w-44">
                  {ACTIVITIES[kind].label}
                  {!startable.has(kind) && <Badge tone="neutral">Soon</Badge>}
                </dt>
                <dd className="text-sm leading-relaxed text-neutral-400">{ACTIVITIES[kind].hint}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <h3 className="mb-1 text-sm font-semibold text-neutral-100">
            The two things BrainCue keeps
          </h3>
          <p className="mb-4 text-sm text-neutral-400">
            They make different promises, so they have different defaults. Both live on the{' '}
            <Link to="/memory" className="text-indigo-300 hover:underline">
              Memory
            </Link>{' '}
            page.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/5 bg-neutral-950/50 p-3.5">
              <p className="mb-1 flex items-center gap-2 text-sm font-medium text-neutral-100">
                Session summary <Badge tone="green">On by default</Badge>
              </p>
              <p className="text-xs leading-relaxed text-neutral-400">
                What a conversation <i>was</i>: the topic, what was decided, who committed to
                what, and a few lines in the speakers&rsquo; own words. Filed into the Space it
                happened in, retrievable by the next conversation there, deleted with its session.
              </p>
            </div>
            <div className="rounded-xl border border-white/5 bg-neutral-950/50 p-3.5">
              <p className="mb-1 flex items-center gap-2 text-sm font-medium text-neutral-100">
                Long-term memory <Badge tone="neutral">Off until allowed</Badge>
              </p>
              <p className="text-xs leading-relaxed text-neutral-400">
                What is true about <i>you</i>: a standing preference, a recurring person, an
                ongoing project. Proposed after a session and recalled only once you approve it —
                editable and deletable at any time.
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">
            Both need a Space. A conversation kept without one is not summarised and proposes
            nothing — it helped you live, and leaves its transcript.
          </p>
        </Card>

        <Card>
          <h3 className="mb-1 text-sm font-semibold text-neutral-100">Keyboard shortcuts</h3>
          <p className="mb-4 text-sm text-neutral-400">
            Global — they work while another app has focus. All are rebindable in Settings.
          </p>
          <dl className="space-y-2">
            {SHORTCUT_DEFS.map((s) => (
              <div key={s.id} className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-neutral-300">
                  {s.label}
                  <span className="ml-2 text-xs text-neutral-500">{s.description}</span>
                </dt>
                <dd className="shrink-0 rounded-md border border-white/10 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-300">
                  {nbsp(s.default)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        {FAQS.map((group) => (
          <Card key={group.group}>
            <h3 className="mb-1 text-sm font-semibold text-neutral-100">{group.group}</h3>
            <div className="mt-2">
              {group.items.map((item) => (
                <FaqItem key={item.q} item={item} />
              ))}
            </div>
          </Card>
        ))}

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-neutral-100">Still stuck?</h3>
          <p className="mb-3 text-sm leading-relaxed text-neutral-400">
            BrainCue is open source and developed in the open — the design documents are the
            source of truth the code follows, not a write-up produced afterwards. If something is
            wrong, an issue is genuinely useful.
          </p>
          <div className="flex flex-wrap gap-2">
            {/* `target="_blank"` is the whole mechanism: main's
                setWindowOpenHandler (windows/mainWindow.ts) opens it in the OS
                browser and denies the in-app window, so no IPC is needed. */}
            <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
              <Button variant="default">Report an issue</Button>
            </a>
            <a href={REPO} target="_blank" rel="noreferrer">
              <Button variant="ghost">Source &amp; docs</Button>
            </a>
            <Link to="/whats-new">
              <Button variant="ghost">What&rsquo;s new</Button>
            </Link>
            <Link to="/settings">
              <Button variant="ghost">Open Settings</Button>
            </Link>
          </div>
        </Card>
      </div>
    </Page>
  );
}
