<p align="center">
  <img src="resources/icon.png" alt="BrainCue" width="128" height="128" />
</p>

<h1 align="center">BrainCue</h1>

<p align="center">
  <strong>The AI that's in the room with you — and remembers being there.</strong><br />
  BrainCue hears the conversation you're actually in — a standup, a client call,
  an interview, a study session — contributes through a floating,
  <em>screen-share-invisible</em> Cue Card, and files what mattered back into the
  Space it happened in, so the next one starts where the last one ended.<br />
  Local-first. Bring your own AI key.
</p>

<p align="center">
  <a href="https://github.com/tpikachu/BrainCue/releases"><img alt="Download" src="https://img.shields.io/badge/download-Releases-5C6BC0?style=flat-square" /></a>
  <a href="https://tpikachu.github.io/BrainCue/"><img alt="Website" src="https://img.shields.io/badge/website-braincue-4F46E5?style=flat-square" /></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-2D2D2D?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-3FB950?style=flat-square" />
  <img alt="Built with Electron" src="https://img.shields.io/badge/Electron-React%20%C2%B7%20TypeScript-47848F?style=flat-square" />
</p>

## You pick an activity, not a mode

There is one start flow for every conversation. You say **what the call is** —
never which engine to run — and everything else follows from that: what it
listens to, when it speaks up, how it frames you, and what shape its summary
takes afterwards.

| Activity | You are… | BrainCue… |
| --- | --- | --- |
| **Meeting or call** | in a standup, a client call, a sync | sits in quietly; surfaces context, open questions, action items, decisions |
| **Project discussion** | talking about ongoing work | recalls what was decided before, and what is still open |
| **Interview** | the candidate | hears each question and streams a grounded answer cue, framed as you |
| **Study or tutoring** | learning something | pulls up the part of your material that bears on what was just said |
| **Personal** | dealing with a landlord, a bank, a doctor | keeps the background straight and catches what you agreed to |
| **Game** · **Just me** | playing, or thinking out loud | an ambient presence that stays out of the way |
| **Something else** | anything the list misses | contributes only when it is confident |

Underneath, these run three engine modes over **one** pipeline — *listen →
decide whether to contribute → ground in your documents → respond*. The mode is
derived, never chosen, because picking a mode *and* a category was the same
question asked twice ([docs/18-ACTIVITIES.md](docs/18-ACTIVITIES.md)).
Interviewing someone and guided tutoring are still to come; the vision and plan
live in [docs/00-VISION.md](docs/00-VISION.md) and
[docs/10-ROADMAP.md](docs/10-ROADMAP.md).

## Spaces, and the two things it remembers

A **Space** is one recurring context — *Tuesday standup*, *Senior engineer ·
Acme*, *House move* — holding the documents that ground it. It is also **where a
conversation is kept**: when a session ends you choose whether to keep it, and
in which Space. With no Space, nothing is summarised and nothing is remembered
— the session helped live and leaves only its transcript.

Two different things get kept, with two different defaults, because they make
two very different promises:

| | **Session summary** | **Long-term memory** |
| --- | --- | --- |
| Answers | "what happened in that call?" | "what should you always know about me?" |
| Example | *"Phase two is blocked on renewal pricing. Priya is chasing legal."* | *"Never commits to dates in standup."* |
| Default | **on** | **off** — until you turn it on |
| Review | none | **every item, one at a time** |
| Scope | its Space, always | its Space, or profile-wide |
| Lifetime | deleted with its session | outlives it |

A summary is a précis of a conversation you chose to run, from a transcript
already on your disk. A memory is a *standing claim about a person* — and a
wrong one is repeated forever, which is why nothing is ever remembered
silently: memories are only ever **proposed**, and only the ones you approve are
recalled. Details in [docs/16-CONTINUITY.md](docs/16-CONTINUITY.md).

<p align="center">
  <img src="docs/images/memory-review.png" width="820" alt="The Memory page: three suggestions from one standup, each tagged with the Space it came from and its confidence, each waiting on an Approve or Reject." />
  <br /><sub><b>Proposed, not remembered</b> — what one kept conversation suggested. Nothing here is recalled until you press Approve.</sub>
</p>

## See it in action

<!-- Captured from the real app (see e2e/README.md#capturing-marketing-media).
     The clips below are from the interview activity, which is the easiest one
     to film end-to-end; the pipeline they show is the same one every activity
     runs. -->

<p align="center">
  <img src="docs/media/cuecard-stream.gif" width="360" alt="The floating Cue Card: the interviewer's question is transcribed live, then a grounded, cited answer streams in." />
  <br /><sub><b>Live, in real time</b> — the question is heard, and a grounded, cited answer streams into the Cue Card.</sub>
</p>

<p align="center">
  <img src="docs/media/stealth-split.gif" width="820" alt="The same moment in two views: your screen shows the Cue Card over a video call; the other side's screen share shows the call with the app absent." />
  <br /><sub><b>The same moment, two views</b> — your screen has BrainCue; the shared screen (and any recording) has nothing.</sub>
</p>

<p align="center">
  <a href="docs/media/braincue-demo.mp4"><b>▶ Watch the demo</b></a> — a captioned walkthrough, captured from the real app.
</p>

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <img src="docs/media/format-switch.gif" width="240" alt="Re-tell any answer as key points, an explanation, or a STAR story — switched live." />
      <br /><sub><b>Re-tell it your way</b><br />key points · explanation · STAR story</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <img src="docs/media/coding-solve.gif" width="240" alt="A captured coding problem is solved in the Cue Card with an optimal solution and complexity analysis." />
      <br /><sub><b>Live coding rounds</b><br />optimal solution + complexity</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <img src="docs/media/mock-interview.gif" width="240" alt="An AI interviewer asks a question aloud and BrainCue answers it in the Cue Card." />
      <br /><sub><b>Practice mode</b><br />the AI asks · BrainCue answers</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/interview-grounded.gif" width="640" alt="The session page: pick a profile, and each session is grounded in its own documents — résumé, job description, company research." />
  <br /><sub><b>Grounded in your story</b> — every session draws on its own documents (résumé, JD, company research), parsed and indexed on your machine.</sub>
</p>

---

> ⚠️ **Use only where AI assistance is permitted.** Your data stays on your
> machine; only the retrieved context + the current moment of conversation is
> sent to your AI provider.

## Why BrainCue

- 🎙️ **Hears the real conversation** — system-audio loopback puts it inside your
  actual calls and meetings; a mic covers in-person. It flags the moment worth
  responding to, in real time.
- 💡 **Grounded contributions** — cues are drawn from *your* documents via
  on-device retrieval (local RAG), not generic filler — and it says so when it
  doesn't know, instead of inventing.
- 🪟 **The Cue Card** — an always-on-top panel **excluded from screen sharing &
  recording**: there for you, invisible to everyone else.
- 🗣️ **A voice of its own** — push-to-talk from anywhere: ask by voice and hear
  the answer back, with barge-in when you talk over it.
- 🧠 **Continuity you control** — each conversation you keep is summarised into
  its Space, so the tenth standup is grounded in the previous nine. Long-term
  memory is separate, off by default, and reviewed item by item: nothing is ever
  remembered silently.
- ⌨️ **Global hotkeys** — toggle the Cue Card, solve a copied problem, or
  drag-select a region of the screen to read and answer.
- 🔒 **Local-first & private** — data lives in a local database; your API key is
  encrypted by the OS keychain and never leaves the main process.
- 🔌 **Bring your own AI** — OpenAI today; a provider abstraction with support
  for multiple AI providers is on the roadmap.

## Download

Grab the latest installer from the
[**Releases**](https://github.com/tpikachu/BrainCue/releases) page:

- **Windows** — `.exe` (NSIS installer)
- **macOS** — `.dmg`
- **Linux** — `.AppImage`

Builds are currently **unsigned**, so the OS may warn on first launch — Windows
SmartScreen ("More info → Run anyway"), macOS Gatekeeper (right-click → Open).

## System requirements

BrainCue is a local desktop app that streams live audio to your AI provider
(OpenAI today) for transcription and responses, so a steady internet connection
and a microphone matter more than raw compute.

| | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 10 64-bit (version 2004 / build 19041+), macOS 11, or a modern 64-bit Linux | Windows 11, macOS 13+ |
| **CPU** | Dual-core x64 / Apple Silicon | Quad-core or better |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | ~600 MB (app) + room for local data | 2 GB+ free (profiles, vectors, transcripts) |
| **GPU** | Any (integrated is fine) | Discrete or modern integrated |
| **Display** | 1280 × 800 | 1920 × 1080 or larger |
| **Audio** | Microphone | Mic + system-audio loopback (to hear the other side) |
| **Network** | Broadband internet | Low-latency broadband (for real-time transcription) |

You also need your **own OpenAI API key** (set in Settings) with access to the
models in use (Realtime/STT, Responses, embeddings, TTS, Vision). Support for
additional providers is planned — see the [roadmap](docs/10-ROADMAP.md).

**Notes**
- **Privacy Mode** (hiding the app from screen sharing/recording) is most reliable
  on **Windows 10 version 2004+** and Windows 11; on older builds the window may
  show as black to viewers instead of being cleanly excluded.
- **System-audio capture** (the other side's voice in online calls) uses Windows
  loopback automatically. On **macOS**, capturing system audio needs a virtual
  audio device (e.g. BlackHole); the microphone path works without one.
- **Hybrid-GPU laptops** (e.g. NVIDIA Optimus): if a window shows up blank/black,
  launch with `--disable-gpu` (or set `AI_DISABLE_GPU=1`) to fall back to software
  rendering.

## Stack
Electron · React · TypeScript · Vite (electron-vite) · TailwindCSS · Zustand ·
SQLite (better-sqlite3) · Drizzle ORM · OpenAI Node SDK (Responses, embeddings,
STT/Realtime, TTS, Vision) · electron-builder.

## Design docs

BrainCue is docs-driven — the design documents are the source of truth the
implementation follows, not a write-up produced afterwards.

📖 **[Read them as a site](https://tpikachu.github.io/BrainCue/)** ·
📁 **[Browse them here](docs/)** ([index with descriptions](docs/README.md))

Start with the [Vision](docs/00-VISION.md) (the north star), the
[PRD](docs/01-PRD.md) (domain model and requirements), and the
[Roadmap](docs/10-ROADMAP.md) (phases + the development rules). For how v2
actually works: [Activities](docs/18-ACTIVITIES.md) (one list, no mode picker),
[Spaces & profile](docs/17-SPACES-AND-PROFILE.md),
[Active profile](docs/19-ACTIVE-PROFILE.md), and
[Continuity](docs/16-CONTINUITY.md) (summaries, memory, and why a Space is where
a conversation is kept). The [Engine plan](docs/12-ENGINE-PLAN.md) describes the
six-stage pipeline every mode configures;
[Architecture](docs/02-ARCHITECTURE.md), [Database](docs/04-DATABASE.md),
[IPC map](docs/05-IPC-MAP.md), and
[API key security](docs/07-API-KEY-SECURITY.md) cover the rest.

## Getting started
```bash
npm install
cp .env.example .env      # optional: put OPENAI_API_KEY for dev
npm run db:generate       # generate the initial Drizzle migration
npm run dev               # launch the app with HMR
```
In production you set the key in **Settings** (encrypted via OS secure storage).

## Scripts
| Script | Purpose |
|---|---|
| `npm run dev` | electron-vite dev (HMR) |
| `npm run typecheck` | type-check main + renderer |
| `npm run db:generate` | generate SQL migrations from the Drizzle schema |
| `npm run build` | typecheck + bundle |
| `npm run icon` | regenerate app icons from `resources/icon.svg` |
| `npm run package` / `package:win` / `package:mac` | build installer via electron-builder (auto-cleans `release/` + kills running app first) |

## Releasing

Installers are built and published by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) — Windows,
macOS, and Linux in parallel.

1. Bump `version` in `package.json` (and add a `changelog/` entry).
2. Commit, then tag it to match: `git tag v0.5.0 && git push origin v0.5.0`
   (the tag **must** equal `v` + the `package.json` version).
3. The workflow builds each platform and uploads to a **draft** GitHub Release
   named `v0.5.0`. Review it in the Releases tab and click **Publish**.

To produce installers **without** publishing (e.g. to test a build), run the
workflow manually from the **Actions** tab — they're attached as downloadable
artifacts instead.

## Security invariants
- The API key lives **only** in the main process; the renderer learns a
  boolean `apiKeyPresent` and nothing more.
- All provider/DB/secret access happens in main; the renderer talks via the
  typed `window.api` preload bridge.
- `.env` is gitignored; the key is never logged (logger redacts `sk-…`).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
the pre-push gate (`typecheck` + `test` + `build`), the IPC contract, and the
privacy/security invariants that must not regress.

## Project status

Actively developed, currently **v2.0.x**. The interview path shipped end-to-end
in v1.5 (profiles, live grounded answers, the Cue Card, region/clipboard solve,
practice with an AI voice, coaching reports) and is still fully supported — it
just no longer defines the product. v2 made meetings and solo sessions the daily
case: one activity picker instead of a mode picker, Spaces as the unit of
context *and* of memory, per-activity summaries, a reviewed long-term memory,
voice, and one active profile scoping the whole dashboard.

Next up is interviewing someone and guided tutoring — see
[docs/10-ROADMAP.md](docs/10-ROADMAP.md) for what's planned and the
[changelog](changelog/) for what shipped in each release.
