# 21 · Media — the demo film, the GIFs, and the screenshots

Everything BrainCue shows the world is a recording of BrainCue. Nothing here is
mocked up in a design tool, and nothing is staged in a fixture that a user could
not reproduce. This document is how those assets get made, why each one exists,
and what has to be true before any of them ship.

The executable half of this document is three files:

| | |
|---|---|
| [`e2e/media.capture.spec.ts`](../e2e/media.capture.spec.ts) | drives the app and captures the film's frames + writes the manifest |
| [`e2e/screenshots.capture.spec.ts`](../e2e/screenshots.capture.spec.ts) | drives the app and captures the stills |
| [`scripts/build-media.mjs`](../scripts/build-media.mjs) | turns frames into the film and the GIFs |

`scripts/media.mjs` runs all of it.

---

## 1 · Quick start

```bash
npm run media -- check     # is ffmpeg able to do this at all?
npm run media              # capture everything, then build everything (~25 min)
```

Individual steps, for when only one thing changed:

```bash
npm run media -- shots     # stills only          → docs/images/*.png
npm run media -- scenes    # the film's frames    → docs/media/frames/demo/**
npm run media -- film      # assemble from frames → docs/media/braincue-demo.mp4
npm run media -- gifs      # cut the loops        → docs/media/*.gif
npm run media -- build     # film + gifs, no capture
```

**Prerequisites**

- `OPENAI_API_KEY` in `.env`. Every answer in the film is a real answer to a real
  question. Without a key the capture specs skip themselves and leave the old
  assets in place — which looks like success until someone watches the output,
  so `media.mjs` refuses to start instead.
- **ffmpeg with libass**, on PATH. `winget install Gyan.FFmpeg` ·
  `brew install ffmpeg` · `apt install ffmpeg`. `npm run media -- check` prints
  exactly which filters are missing.
- **A display.** The app is driven visibly; this will not run on a headless CI
  box.
- A **built app** (`npm run build`) — the harness launches `out/main/index.js`.

Capture is opt-in: `playwright.config.ts` ignores `*.capture.spec.ts` unless
`E2E_CAPTURE` is set, because these specs need a real key and write into the
repo. `media.mjs` sets it for you — and that is the point of it, because
`E2E_CAPTURE=1 npx …` is a bash-ism that silently does nothing in `cmd.exe`, so
the documented command used to work for about half the people who ran it.

---

## 2 · What we are actually selling

The film has about twenty seconds to make someone want the next two minutes, and
the thing that earns it is not a feature. It is a problem they have had.

> You are in the call. Your notes are not.
>
> The context that would help is in a document you cannot open right now.
>
> And when it ends, everything it taught you is gone.

Three sentences, three cards, no product. Then the app appears and every scene
after that answers one of them. That is the spine, and it is why the acts are
named the way they are:

| Act | Answers | Scenes |
|---|---|---|
| **One · What it knows** | "the context is in a document I can't open" | Home, profile, Spaces, documents, activities, tailored résumé |
| **Two · In the room** | "I'm in the call right now" | consent, transcription, the Cue Card, grounding, citations, formats, coding |
| **Two½ · Invisible in the share** | "they will see it" — the objection that kills the whole idea | the card on your screen, the split view, Privacy Mode |
| **Three · What survives the call** | "everything it taught me is gone" | save prompt, sessions, report, memory review, approval, a fact that changed, recall, the next brief |
| **Four · It is yours** | the objection nobody says out loud | the key, insights, outro |

Three rules that are not style preferences:

1. **Never show something that is not shipped.** Anything behind a flag in
   [`src/shared/flags.ts`](../src/shared/flags.ts) — `jobSearch`, `storyBank`,
   `tutor`, `interviewerAssist` — is off the storyboard, whatever state the code
   is in. A viewer who installs the app and cannot find what they watched has
   been lied to.
2. **Never say a number the product does not measure**, and never put a metric
   on screen that the app did not produce.
3. **Interviews are one activity, not the product.** If the film opens on an
   interview it has re-described BrainCue as Interview Copilot in the first ten
   seconds. The meeting comes first, and the interview sits in the middle of the
   act where it belongs. See [00-VISION.md](00-VISION.md).

---

## 3 · The storyboard

Read this next to `e2e/media.capture.spec.ts` — the order below is the order the
spec captures in, and the captions are verbatim.

### Act 0 · Why (generated cards, no app)

| # | Type | Hold | On screen |
|---|---|---|---|
| — | title | 4.8s | **You are in the call. / Your notes are not.** · *A local-first AI companion for live conversations* |
| — | chapter | 4.0s | The context that would help is in a document you cannot open right now. |
| — | chapter | 4.0s | And when the call ends, everything it taught you is gone. |

### Act 1 · What it knows

| Scene | Kicker | Caption | Spotlight |
|---|---|---|---|
| `01-home` | Home | Everything starts with one question: what is this call? | |
| `02-profile` | Your material | Your résumé and documents go in once. They stay on this machine. | |
| `03-spaces` | Library · Spaces | A Space is one recurring context — a standup, a role, a house move. | |
| `04-documents` | Library · Documents | Everything is indexed locally. Nothing is uploaded anywhere. | |
| `05-activity` | New Space | You say what the conversation IS. Never which mode to run. | the activity `<select>` |
| `06-tailor` | Interview Space | Paste a job description, and it offers to tailor your résumé to that role. | the offer card |

`03-spaces` is the scene that has to carry "not an interview tool" on its own —
it is the only frame where a standup, three roles, a syllabus and a house move
are visible at the same time. It is why the sample data has seven Spaces across
five activities rather than four.

### Act 2 · In the room

| Scene | Kicker | Caption | Spotlight |
|---|---|---|---|
| `07-start` | Before anything is captured | It tells you exactly what will be recorded, and exactly what will be sent. | the transparency panel |
| `08-space-choice` | | And what will survive the call. No Space, and nothing is kept. | the Space warning |
| `09-cuecard` ▶ | The Cue Card | It hears the question, transcribes it live, and streams a grounded answer into an overlay. | |
| `10-grounded` ▶ | Grounded | The answer is built from YOUR material — not from what the model assumes about you. | |
| `11-citations` | Provenance | Every card says where it came from, so you can check it in the two seconds you have. | |
| `12-star` ▶ | Answer formats | Re-tell the same answer as key points, a short explanation, or a STAR story. | |
| `13-coding` ▶ | Capture a region | Grab any part of your screen and it solves what is in it — with the complexity. | |

▶ = streamed, captured as a real frame sequence.

### Act 2½ · Invisible in the share

Its own chapter, and deliberately so. For an interview this is not a setting, it
is the proposition — help that is worthless the moment the other side can see
it. It used to be a single Settings screenshot near the end of the film, which
is how a headline feature reads as a toggle.

| Scene | Kicker | Caption | Spotlight |
|---|---|---|---|
| — (chapter) | And they cannot see any of it | **Invisible in the share.** | |
| `14-stealth` | On your screen | This is on your screen while you are sharing it. | |
| `stealth-split.gif` | | *(the explainer's own words — no caption)* | |
| `15-privacy` | Privacy Mode | Every window is excluded from screen capture at the OS level. On by default. | the privacy card |

### Act 3 · What survives the call

The act runs the loop **twice**, because that is the only way the last two scenes
can exist. See § The memory act below — the ordering is load-bearing, not
narrative preference.

| Scene | Kicker | Caption | Spotlight |
|---|---|---|---|
| `16-save` | When it ends | One decision, once: keep this conversation, and which Space it belongs to. | |
| `17-sessions` | Sessions | Every conversation, with its full transcript, in a database on your disk. | |
| `18-report` | After a meeting | Decisions, action items and open questions — quoted from what was actually said. | |
| `19-memory-review` | Memory | It proposes what seems worth remembering. It never decides. | the Approve button |
| `20-memory-approved` | | Only what you approve is ever recalled. Everything else expires unremembered. | |
| `21-conflict` | When a fact changes | September became October. It says so — instead of quietly believing both. | the Replace button |
| `22-recall` ▶ | A week later | The next conversation in that Space already knows what the last one settled. | |
| `23-brief` | Next time | And an interview opens with a brief built from the role and everything you have said. | |

### Act 4 · It is yours

| Scene | Kicker | Caption | Spotlight |
|---|---|---|---|
| `24-key` | Your key, your account | The OpenAI key is encrypted by the OS and never leaves the main process. | the key card |
| `25-insights` | Insights | Trends across every conversation you kept — still only on this machine. | |
| `26-home` | | One companion, for every conversation you actually have. | |
| — (title) | | **Free, open source, and local-first.** · *github.com/tpikachu/BrainCue* | |

Total: **35 scenes**, around **2:10–2:40** depending on how long the streamed
answers run.

### The memory act

The order of Act 3 is the act. `memory.conflicts()` pairs a **pending** candidate
against a **current** one, and current means *approved*
([`memories.repo.ts` → `currentByFactKey`](../src/main/db/repositories/memories.repo.ts)).
Keep both standups back to back and every candidate is pending, so nothing can
conflict with anything — and the run reports "the extractor found no
contradiction", blaming the model for a sequencing mistake. So the capture does
what a person does:

1. keep week one → its candidates arrive pending
2. shoot the review queue
3. **approve them** → shoot the approved state
4. keep week two, where the same fact now has a different value
5. shoot the conflict, then a new session where the approved fact is recalled

Steps 3 and 5 are not decoration. Nothing can be superseded and nothing can be
recalled until something is actually approved.

---

## 4 · How the film is made to look like a film

Four techniques, all in `scripts/build-media.mjs`, each fixing something that
made the previous cut read as a slideshow.

**Cross-fades, not cuts.** Every scene is a separate `.mp4`; the assembler
chains them with `xfade` at 0.5s. A hard cut between two dark UI screenshots
looks like a broken video player.

**A slow push on every still.** `zoompan` moves 5.5% over the hold. It is
deliberately below the threshold where anyone notices it as an effect — the eye
reads a completely static frame as a stall and starts looking for the scrubber.
The frame is laid out on a 2× canvas first, because `zoompan` on a 1× source has
to invent the pixels it magnifies and the result crawls.

**Text as a subtitle track, not burned per segment.** All captions, kickers,
titles and callout labels are one generated `.ass` file applied over the finished
cut. This is not a refactor for its own sake:

- A caption can fade (`\fad`) and move (`\move`). `drawtext` can do neither
  without expression gymnastics.
- Caption timings are computed from the segment durations **minus** the
  transitions, in the same pass that computes the `xfade` offsets. Pacing and
  captions cannot drift apart, because they are the same numbers.
- The caption text never touches an ffmpeg filter string, so a colon or an
  apostrophe cannot break the render. The old captions were written with hyphens
  where they wanted em dashes for exactly this reason.

> The one thing to know if you edit the ASS styles: with `BorderStyle=3`,
> **`OutlineColour` is the fill of the box behind the text** and `BackColour`
> becomes the drop shadow. Put the translucent black on `BackColour` — the
> intuitive-looking choice — and the caption renders as bare white text over the
> UI, unreadable on any light panel.

**A long answer is played back faster, never trimmed.** How long an answer takes
is up to the model — the same scene came back as 24 frames on one run and 260 on
the next, which at the authored rate is a 26-second scene. So the authored `fps`
is a floor: anything longer than `maxSec` (default 9s) is sped up to fit. Every
frame is still shown, in order, with nothing cut from the middle. Speed is the
one distortion a viewer reads correctly without being told; a jump cut in the
middle of a stream is not.

**Callout rectangles are measured, never typed.** A spotlight comes from
`boundingBox()` on the real element at capture time, scaled to the canvas and
written into the manifest. A hand-typed coordinate would keep pointing at where
the button used to be, silently, forever.

### The theme

| | |
|---|---|
| Canvas | 1280 × 800, 30 fps, `#08080C` letterbox |
| Accent | `#8E9BFF` (kickers, callouts, progress bar) |
| Caption | 30px, white, translucent box hugging the text, 44px from the bottom |
| Kicker | 19px, accent, uppercase, tracked, 104px from the bottom |
| Title card | 58px bold on an animated radial gradient, rising 24px into place |
| Transition | `xfade`/fade, 0.5s (0.7s into and out of cards) |
| Open / close | fade from and to black, 0.5s / 0.7s |
| Progress | a 3px accent hairline along the bottom |

---

## 5 · The manifest

`e2e/media.capture.spec.ts` writes `docs/media/frames/demo/manifest.json`, and
`build-media.mjs --manifest` reads it. It is the only contract between the two.

```jsonc
{
  "version": 2,
  "width": 1280, "height": 800, "fps": 30,
  "scenes": [
    { "type": "title",   "logo": true, "durationSec": 4.8,
      "eyebrow": "BrainCue", "title": "You are in the call.\nYour notes are not.",
      "subtitle": "A local-first AI companion for live conversations" },

    { "type": "chapter", "durationSec": 2.6, "eyebrow": "One", "title": "What it knows" },

    { "type": "still",   "dir": "01-home", "durationSec": 4.2, "motion": "zoom-in",
      "kicker": "Home", "caption": "…",
      "callout": { "x": 40, "y": 210, "w": 300, "h": 48, "label": "eight activities" } },

    { "type": "motion",  "dir": "09-cuecard", "fps": 10, "tailHoldSec": 3.2,
      "kicker": "The Cue Card", "caption": "…" }
  ]
}
```

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `title` · `chapter` · `still` · `motion` |
| `dir` | still, motion | frame directory under `frames/demo/`, and the scene's identity |
| `durationSec` | title, chapter, still | seconds on screen |
| `fps` | motion | playback rate for the captured frames — a **floor**, see `maxSec` |
| `maxSec` | motion | longest the stream may run (default 9); a longer one is played faster |
| `tailHoldSec` | motion | freeze the last frame this long, so a stream's payoff is readable |
| `motion` | still | `zoom-in` · `zoom-out` · `none` |
| `kicker` / `caption` | still, motion | the eyebrow and the sentence |
| `eyebrow` / `title` / `subtitle` | title, chapter | card text; `\n` is a real line break |
| `logo` | title | composite `resources/icon.png` above the headline |
| `callout` | still, motion | measured rectangle + optional label |
| `transition` / `transitionSec` | all | `fade` (default), any `xfade` name, or `cut` |

A v1 manifest (`{dir, caption, holdSec|fps, tailHoldSec}`) still assembles — old
frames on disk keep working rather than failing cryptically months later.

### Adding a scene

1. Add an `optional('name', …)` block in `media.capture.spec.ts`, in narrative
   order, ending in `shot()` or `clip()`.
2. That is all. The scene registers its own manifest entry as it is captured.

There is no second list to keep in sync, deliberately: the previous version kept
the shots and the manifest apart and filtered one against the other, so a scene
could be captured and never assembled, or listed and never shot.

### Scenes that may not appear

Three depend on a model doing something it is not obliged to do, and each is
allowed to be missing rather than faked:

- **`20-conflict`** needs the extractor to notice that the two seeded standups
  disagree about when phase two starts. If it does not, the scene is dropped.
- **`18/19-memory-*`** need extraction to propose at least one candidate.
- **`17-report`** needs a meeting report to generate.

Any shot can also be skipped for a mundane reason — `optional()` catches, logs,
and carries on, and the run prints exactly what it skipped. **Read that list.**
The run fails only if fewer than 12 scenes were captured, on the grounds that a
film with holes is worth more than no film, but a stub is not.

---

## 6 · The assets

### The film

| | |
|---|---|
| `docs/media/braincue-demo.mp4` | 1280×800 · ~2:30–3:00 · H.264 · silent by default |

Referenced by the README ("▶ Watch the demo") and embedded on the landing page.

**Music.** Optional and never committed:

```bash
BRAINCUE_DEMO_MUSIC=/path/to/track.mp3 npm run media -- film
```

It is mixed at 18% with a 1.5s fade in and a 2s fade out, and `-shortest` keeps
the track from deciding how long the video is. Use something you have the right
to use — CC0, or a licence you bought. Do not commit the audio file.

### The loops

Each is cut from a scene of the film, so a GIF in the README and the same moment
in the video can never show two different takes, and the expensive live run
happens once.

| GIF | From scene | Shows |
|---|---|---|
| `cuecard-stream.gif` | `09-cuecard` | a question heard, an answer streaming into the Cue Card |
| `grounded-answer.gif` | `10-grounded` | an answer built from the user's own material, with sources |
| `format-switch.gif` | `12-star` | the same answer re-told as a STAR story |
| `coding-solve.gif` | `13-coding` | a captured problem solved with its complexity |

Widths are 420–480px on purpose: these are inline loops in a README, GitHub will
not autoplay a video, and the GIF is therefore the delivery format rather than a
legacy one.

### The explainers

The one part of the media set that is **drawn rather than recorded**. They
explain a claim the app makes, which is a different job from showing the app
making it — and some claims cannot be shown at all. Proving the Cue Card is
absent from a screen share needs the frame the *other side* sees, and an
OS-level capture of that frame contains whatever is really behind the window,
i.e. the operator's desktop.

| GIF | Says |
|---|---|
| `stealth-split.gif` | your screen has BrainCue; the shared screen has nothing |
| `memory-loop.gif` | call → keep → propose → approve → recalled, and replaced when it changes |
| `grounding.gif` | your documents stay put; only the matching lines are sent |
| `activities.gif` | you pick the conversation, not the mode |

Source is [`media-src/explainers.html`](../media-src/explainers.html) — one page,
one explainer per `?e=<name>`, every animation on the same 8s loop so the GIF
cycles cleanly:

```bash
node scripts/build-explainers.mjs             # all
node scripts/build-explainers.mjs grounding   # one
```

Rendered in **Electron**, not a browser: the e2e harness deliberately does not
install Playwright's bundled browsers, so there is no Chromium on disk to point
at. Electron is already a dependency, `capturePage()` gives an exact off-screen
capture at a fixed size, and it needs no display.

Two rules hold this together, and they are the reason the category is safe:

1. **A screenshot is never an illustration, and an illustration never passes as
   a screenshot.** These have their own look, and none of them contains a fake
   BrainCue window. If a viewer cannot tell at a glance which is which, the
   explainer is wrong.
2. **An explainer may only state something true of the shipped build.** It is
   drawn, so nothing checks it — which makes it the easiest asset in the repo to
   let rot. Re-read them whenever the behaviour they describe changes.

`stealth-split.gif` predates this rig and is still hand-made. It is the model
the others were drawn to match; port it into `explainers.html` the next time it
needs a change.

> The ground truth behind the stealth claim is
> [`scripts/verify-privacy-capture.mjs`](../scripts/verify-privacy-capture.mjs),
> which takes an OS-level `desktopCapturer` shot of the app's own screen rect
> with Privacy Mode on and off — the same capture family screen-share apps use.
> Run it after Windows feature updates and Electron upgrades. **Its output must
> never be published**: it contains whatever was behind the window.

### The stills

`docs/images/*.png`, from `screenshots.capture.spec.ts`:

| Image | Shows |
|---|---|
| `home.png` | the launcher: greeting, primary actions, capture status, activity cards |
| `profile.png` | the résumé and documents that ground everything |
| `library.png` | the active profile's Spaces |
| `documents.png` | the indexed documents behind them |
| `new-space.png` | the activity picker |
| `tailored-resume.png` | the tailoring offer, with a JD loaded |
| `memory.png` | the two consent switches |
| `memory-review.png` | the review queue, with Approve/Reject visible |
| `sessions.png` | history, scoped to the active profile |
| `meeting-report.png` | decisions, action items, open questions |
| `insights.png` | trends across sessions |
| `settings.png` | models and companion prefs |
| `privacy.png` | Privacy Mode |
| `help.png` | the in-app reference |
| `start-flow.png` | the transparency panel before anything starts |
| `cue-card.png` | a completed, cited answer in the overlay |
| `save-prompt.png` | the one decision at the end of a call |

`memory.png` and `memory-review.png` are the same page at two scroll positions:
the top explains the two switches, the second shows the thing they govern. The
scroll is a fixed `scrollTop`, not `scrollIntoViewIfNeeded` — the Approve row
sits low but technically *on* screen, so "if needed" decides nothing is needed
and both shots come out identical.

---

## 7 · The demo world

Every asset is captured against
[`src/main/services/samples/sampleData.ts`](../src/main/services/samples/sampleData.ts)
— the same thing the **Load sample data** button seeds. Deliberately the same:
a fixture that exists only for the capture is exactly how a product film drifts
from the product, and anyone who watches the video can press one button and be
standing in the same room.

| | |
|---|---|
| **Profile** | Alex Rivera — 8 years, a real résumé with real numbers in it |
| **Spaces** | `meeting` Tuesday standup — Atlas · `project` Atlas migration · `job` Google L4 / Amazon SDE II / Stripe Senior Frontend · `subject` Distributed systems · `personal` House move |
| **Conversations** | 3 standups (21, 7 and 0 days ago), 1 project review, 1 call with the estate agent — all finished, all **unkept** |

The rule that keeps it honest: **nothing downstream is fabricated.** No archives,
no summaries, no memories are written by the seeder. What it seeds is only the
raw input a user would have produced. Every derived artifact in the film is
produced by the real pipeline at capture time, from that input.

Which is why the two older standups are written so that a fact *changes* between
them — phase two starts in September in the first and slips to October in the
second. That contradiction is not decoration. It is the input that lets the
extractor produce a genuine conflict, so the Replace scene shows real output. If
the model misses it, the scene is dropped.

The capture keeps the two older standups (running the real archive + extraction
pipeline) and leaves the most recent one alone — so a user who presses **Load
sample data** after watching still has the decision waiting for them.

---

## 8 · Before you publish

- [ ] Watch the whole film, at full size, with fresh eyes.
- [ ] Read the skip list the capture printed. Was a scene dropped for a real
      reason, or because a selector moved?
- [ ] Every caption still true of the build being shipped.
- [ ] No flagged-off surface visible in any frame — Tailor page, story bank,
      Tutor, Interviewer Assist.
- [ ] No real API key, no real name, no real company in any frame.
- [ ] Sample data only. If a frame shows a Space that is not in
      `sampleData.ts`, the capture ran against the wrong profile.
- [ ] Captions legible at 640px wide (someone will watch this on a phone).
- [ ] `braincue-demo.mp4` under ~10 MB; each recorded GIF under ~150 KB, each
      explainer under ~700 KB (they are wider and hold longer).
- [ ] README and `docs/index.html` reference assets that exist — every path in
      both files resolves.
- [ ] Every explainer still states something true of this build — nothing checks
      them, which makes them the easiest asset here to let rot.
- [ ] On-screen keyboard shortcuts match
      [`src/main/services/shortcuts.ts`](../src/main/services/shortcuts.ts), not
      what the UI copy says. Those have disagreed before.

---

## 9 · Why frames rather than a screen recording

The harness attaches to an **already running** Electron over CDP
(`e2e/fixtures.ts`), because Playwright's `_electron.launch()` is broken on
Electron 30+. `recordVideo` is a **context-creation** option — it cannot be
enabled on a context that was merely connected to. Bursting screenshots works
over CDP, is deterministic, and lets ffmpeg choose the frame rate after the
fact.

It also has a property a real recording does not: `captureStream()` samples
*while the text is growing* and stops when it settles, so a clip contains the
part where something happens and almost nothing else.

Two things decide whether a streamed clip has any motion in it, and both have
bitten:

- **Don't `await` the thing you are filming.** `mock.start()` resolves only once
  the question has been asked *and* answered — await it and you start filming
  after the interesting part is over. Kick it off and sample concurrently.
- **Don't stop on "text stopped changing" alone.** There is a quiet gap between
  the question landing and the first answer token; treat that as the end and you
  get two seconds of nothing. `captureStream` requires `minGrowth` characters to
  have arrived before a settle counts as finished.

`--hold N` in `build-media.mjs` collapses any run of byte-identical frames to at
most N. The app idles before an answer arrives and holds still after it
finishes; leave those in and the clip reads as a static screenshot.

---

## 10 · Keeping captures from rotting

Navigation uses the sidebar's `data-tour="nav-*"` anchors rather than visible
link text. Those anchors are load-bearing for the onboarding tour, so they do
not drift silently — whereas the previous screenshot spec still clicked
"Interview" / "Mock" / "Reports" nav items that the mode-first redesign had
already removed, which is how the assets went stale in the first place.

Three more habits that come from the same lesson:

- Frames land in `docs/media/frames/` (gitignored scratch). Only the built
  `.gif` / `.mp4` and the stills are committed.
- Every frame directory is deleted before it is written, so a stale run's frames
  can never leak into an assembly.
- Asset filenames are stable, so a re-capture refreshes them in place with no
  README or landing-page churn.
